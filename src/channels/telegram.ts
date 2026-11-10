import { Bot, InputFile } from "grammy";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Attachment, ChannelAdapter, IncomingMessage, ReplyFn } from "./types.ts";
import type { ChannelConfig } from "../config.ts";
import {
  registerChannelSender,
  detectMediaType,
  type WidgetButtonSpec,
} from "./registry.ts";
import {
  formatTelegramHtml,
  buildLiveStatusWidget,
  escapeTelegramHtml,
  type LiveStatusState,
} from "./telegram-format.ts";
import { addJob, removeJob, triggerJob } from "../scheduler/scheduler.ts";
import { applyEventDoubleReminders } from "../email/calendar.ts";

const MEDIA_DIR = resolve(import.meta.dir, "../../media/telegram");

/** Maps sender string (@username or numeric ID) → numeric chat ID for outbound messages */
const chatIdMap = new Map<string, number>();

/** Map to store callback actions exceeding Telegram's 64-byte limit */
const callbackActionMap = new Map<string, string>();
let callbackActionCounter = 0;

function registerCallbackAction(action: string): string {
  const byteLen = Buffer.byteLength(action, "utf-8");
  if (byteLen <= 60) {
    return action;
  }
  callbackActionCounter++;
  const key = `act:${callbackActionCounter}_${Date.now().toString(36)}`;
  callbackActionMap.set(key, action);
  return key;
}

function resolveCallbackAction(data: string): string {
  if (data.startsWith("act:") && callbackActionMap.has(data)) {
    return callbackActionMap.get(data)!;
  }
  return data;
}

function parseIsoAndTitle(str: string): { isoStart: string; title: string } {
  let isoStart = "";
  let title = "";
  const match = str.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?):(.*)$/s);
  if (match && !isNaN(new Date(match[1]!).getTime())) {
    isoStart = match[1]!;
    title = match[2]!;
  } else {
    const parts = str.split(":");
    let longestValidDateIdx = -1;
    for (let i = 1; i < parts.length; i++) {
      const candidateDate = parts.slice(0, i).join(":");
      if (!isNaN(new Date(candidateDate).getTime())) {
        longestValidDateIdx = i;
      }
    }
    if (longestValidDateIdx > 0) {
      isoStart = parts.slice(0, longestValidDateIdx).join(":");
      title = parts.slice(longestValidDateIdx).join(":");
    }
  }
  return { isoStart, title: title.trim() || "Event" };
}

/** Formats WidgetButtonSpec[][] into Telegram InlineKeyboardMarkup */
type TelegramInlineButton =
  | { text: string; url: string }
  | { text: string; callback_data: string };

function toInlineKeyboard(buttons?: WidgetButtonSpec[][]): {
  inline_keyboard: TelegramInlineButton[][];
} | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((btn): TelegramInlineButton => {
        if (btn.url) {
          return { text: btn.label, url: btn.url };
        }
        return {
          text: btn.label,
          callback_data: registerCallbackAction(btn.action),
        };
      })
    ),
  };
}

type HudState = {
  messageId?: number;
  isNativeWidget?: boolean;
  startedAt: number;
  steps: string[];
  initPromise?: Promise<{ messageId: number; isNativeWidget: boolean }>;
  updatePromise?: Promise<void>;
};

const activeHudByChatId = new Map<number, HudState>();
const nativeWidgetsByMsgId = new Map<number, boolean>();

export function createTelegramAdapter(
  config: ChannelConfig,
  botOptions?: any
): ChannelAdapter & { handleUpdate?(update: any): Promise<void> } {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

  const bot = new Bot(token, botOptions);
  let handler: ((msg: IncomingMessage, reply: ReplyFn) => void) | null = null;

  async function clearActiveHud(chatId: number): Promise<void> {
    const hud = activeHudByChatId.get(chatId);
    if (!hud) return;
    activeHudByChatId.delete(chatId);

    if (hud.initPromise) {
      try {
        const res = await hud.initPromise;
        if (!hud.messageId && res?.messageId) {
          hud.messageId = res.messageId;
        }
      } catch {}
    }

    if (hud.updatePromise) {
      try {
        await hud.updatePromise;
      } catch {}
    }

    if (hud.messageId) {
      try {
        await bot.api.deleteMessage(chatId, hud.messageId);
      } catch {}
    }
  }

  async function sendTextWithFallback(chatId: number, text: string): Promise<number[]> {
    const chunks = splitMessage(text, 4000);
    const ids: number[] = [];
    for (const chunk of chunks) {
      const htmlChunk = formatTelegramHtml(chunk);
      try {
        const msg = await bot.api.sendMessage(chatId, htmlChunk, { parse_mode: "HTML" });
        ids.push(msg.message_id);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.toLowerCase().includes("can't parse entities")) {
          const fallback = await bot.api.sendMessage(chatId, chunk);
          ids.push(fallback.message_id);
        } else {
          throw err;
        }
      }
    }
    return ids;
  }

  async function sendWidgetMessage(
    chatId: number,
    opts: {
      html: string;
      chatData?: Record<string, unknown>;
      fallbackText?: string;
      buttons?: WidgetButtonSpec[][];
    }
  ): Promise<{ messageId: number; isNativeWidget: boolean }> {
    const replyMarkup = toInlineKeyboard(opts.buttons);
    const shouldUseNative = process.env.TELEGRAM_NATIVE_HTML_WIDGET !== "0";

    if (shouldUseNative) {
      // 1. Attempt Bot API 10.4 native sendWidget via Grammy raw API
      try {
        const rawApi = (bot.api as any).raw;
        if (rawApi && typeof rawApi.sendWidget === "function") {
          // When native reply_markup is attached below the widget bubble, remove duplicate in-card
          // <div class="actions-grid"> so mobile Telegram renders clean native inline buttons
          // without double buttons or unresponsive in-webview taps.
          let widgetHtml = opts.html;
          if (replyMarkup) {
            widgetHtml = widgetHtml.replace(/<div class="actions-grid">[\s\S]*?<\/div>/g, "");
          }

          const payload: Record<string, any> = {
            chat_id: chatId,
            html: widgetHtml,
            chat_data: opts.chatData ? JSON.stringify(opts.chatData) : undefined,
          };
          if (replyMarkup) {
            payload.reply_markup = replyMarkup;
          }
          const res = await rawApi.sendWidget(payload);
          if (res && res.message_id) {
            nativeWidgetsByMsgId.set(res.message_id, true);
            return { messageId: res.message_id, isNativeWidget: true };
          }
        }
      } catch {
        // Seamlessly fall back
      }
    }

    // 2. Fall back to standard message with HTML + inline keyboard
    const fallback = opts.fallbackText || formatTelegramHtml("Interactive Card");
    try {
      const sendOptions: Record<string, any> = { parse_mode: "HTML" };
      if (replyMarkup) sendOptions.reply_markup = replyMarkup;
      const msg = await bot.api.sendMessage(chatId, fallback, sendOptions as any);
      nativeWidgetsByMsgId.set(msg.message_id, false);
      return { messageId: msg.message_id, isNativeWidget: false };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.toLowerCase().includes("can't parse entities")) {
        const sendOptions: Record<string, any> = {};
        if (replyMarkup) sendOptions.reply_markup = replyMarkup;
        const msg = await bot.api.sendMessage(chatId, fallback, sendOptions as any);
        nativeWidgetsByMsgId.set(msg.message_id, false);
        return { messageId: msg.message_id, isNativeWidget: false };
      }
      throw err;
    }
  }

  async function updateWidgetMessage(
    chatId: number,
    messageId: number,
    isNativeWidget: boolean,
    opts: {
      chatData: Record<string, unknown>;
      fallbackText?: string;
      buttons?: WidgetButtonSpec[][];
    }
  ): Promise<void> {
    if (isNativeWidget) {
      try {
        const rawApi = (bot.api as any).raw;
        if (rawApi && typeof rawApi.editMessageWidgetData === "function") {
          await rawApi.editMessageWidgetData({
            chat_id: chatId,
            message_id: messageId,
            chat_data: JSON.stringify(opts.chatData),
          });
          return;
        }
      } catch {
        // Fall through to editMessageText if native update fails
      }
    }

    const replyMarkup = toInlineKeyboard(opts.buttons);
    const text = opts.fallbackText || "";
    try {
      const editOptions: Record<string, any> = { parse_mode: "HTML" };
      if (replyMarkup) editOptions.reply_markup = replyMarkup;
      await bot.api.editMessageText(chatId, messageId, text, editOptions as any);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.toLowerCase().includes("message is not modified")) {
        return;
      }
      if (errMsg.toLowerCase().includes("can't parse entities")) {
        try {
          const editOptions: Record<string, any> = {};
          if (replyMarkup) editOptions.reply_markup = replyMarkup;
          await bot.api.editMessageText(chatId, messageId, text, editOptions as any);
        } catch {}
      }
    }
  }

  function isMetaMessage(text: string): boolean {
    const t = text.trim();
    if (t.startsWith("Thinking")) return true;
    if (t.startsWith("Working")) return true;
    if (t.startsWith("Running tool:")) return true;
    if (t.startsWith("Status:")) return true;
    if (t.startsWith("Progress")) return true;
    return false;
  }

  function getPhase(step: string): LiveStatusState["phase"] {
    const lower = step.toLowerCase();
    if (lower.startsWith("thinking")) return "thinking";
    if (lower.startsWith("running tool") || lower.startsWith("tool")) return "tool";
    return "working";
  }

  function createReplyFn(chatId: number): ReplyFn {
    return async (replyText: string) => {
      const isMeta = isMetaMessage(replyText);
      if (isMeta) {
        let hud = activeHudByChatId.get(chatId);
        if (!hud) {
          hud = {
            startedAt: Date.now(),
            steps: [replyText],
          };
          activeHudByChatId.set(chatId, hud);
          const widget = buildLiveStatusWidget({
            phase: getPhase(replyText),
            currentStep: replyText,
            steps: hud.steps,
            startedAt: hud.startedAt,
          });
          const initPromise = sendWidgetMessage(chatId, {
            html: widget.html,
            chatData: widget.chatData,
            fallbackText: widget.fallbackHtml,
          });
          hud.initPromise = initPromise;
          try {
            const res = await initPromise;
            hud.messageId = res.messageId;
            hud.isNativeWidget = res.isNativeWidget;
          } catch {
            activeHudByChatId.delete(chatId);
          } finally {
            hud.initPromise = undefined;
          }
        } else {
          // If widget initialization is still in-flight, await it so messageId is available
          if (hud.initPromise) {
            try {
              const res = await hud.initPromise;
              if (res?.messageId) {
                hud.messageId = res.messageId;
                hud.isNativeWidget = res.isNativeWidget;
              }
            } catch {}
          }

          if (hud.steps[hud.steps.length - 1] !== replyText) {
            hud.steps.push(replyText);
          }
          const widget = buildLiveStatusWidget({
            phase: getPhase(replyText),
            currentStep: replyText,
            steps: hud.steps,
            startedAt: hud.startedAt,
          });
          if (hud.messageId) {
            const messageId = hud.messageId;
            const isNative = hud.isNativeWidget ?? false;
            const updateTask = async () => {
              await updateWidgetMessage(chatId, messageId, isNative, {
                chatData: widget.chatData,
                fallbackText: widget.fallbackHtml,
              });
            };
            hud.updatePromise = (hud.updatePromise || Promise.resolve())
              .then(updateTask)
              .catch((err) => {
                console.warn("[telegram] Failed to update live HUD widget:", err);
              });
            await hud.updatePromise;
          }
        }
        return;
      }

      // Final non-meta response: delete transient HUD
      await clearActiveHud(chatId);

      const trimmed = replyText.trim();
      if (trimmed && trimmed !== "(no response)") {
        await sendTextWithFallback(chatId, replyText);
      }
    };
  }

  function resolveChatId(recipient: string): number {
    if (chatIdMap.has(recipient)) {
      return chatIdMap.get(recipient)!;
    }
    const parsed = parseInt(recipient, 10);
    if (!isNaN(parsed)) return parsed;
    if (config.allowFrom.length === 1 && chatIdMap.has(config.allowFrom[0]!)) {
      return chatIdMap.get(config.allowFrom[0]!)!;
    }
    throw new Error(`Unknown Telegram recipient: ${recipient}`);
  }

  async function handleInteractiveAction(params: {
    action: string;
    chatId: number;
    sender: string;
    senderName: string;
    answerQuery: (text: string) => Promise<void>;
    ctx: any;
  }) {
    const { chatId, sender, senderName, answerQuery, ctx } = params;
    const action = resolveCallbackAction(params.action);

    // Check allowlist (empty = allow all)
    if (config.allowFrom.length > 0 && !config.allowFrom.includes(sender)) {
      await answerQuery("Unauthorized");
      return;
    }

    chatIdMap.set(sender, chatId);

    // 1. double_remind:<ISO_START>:<TITLE>
    if (action.startsWith("double_remind:")) {
      const rest = action.slice("double_remind:".length);
      const { isoStart, title } = parseIsoAndTitle(rest);

      const start = new Date(isoStart);
      const now = Date.now();
      const time1h = new Date(start.getTime() - 60 * 60 * 1000);
      const time30m = new Date(start.getTime() - 30 * 60 * 1000);

      if (time1h.getTime() > now) {
        addJob({
          name: `Reminder (1h before): ${title}`,
          cronExpr: `${time1h.getMinutes()} ${time1h.getHours()} ${time1h.getDate()} ${time1h.getMonth() + 1} *`,
          message: `Reminder: "${title}" starts in 1 hour (${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})!`,
          channel: "telegram",
          sender,
          oneShot: true,
          mode: "reminder",
        });
      }

      if (time30m.getTime() > now) {
        addJob({
          name: `Reminder (30m before): ${title}`,
          cronExpr: `${time30m.getMinutes()} ${time30m.getHours()} ${time30m.getDate()} ${time30m.getMonth() + 1} *`,
          message: `Reminder: "${title}" starts in 30 minutes (${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})!`,
          channel: "telegram",
          sender,
          oneShot: true,
          mode: "reminder",
        });
      }

      // Patch Google Calendar event with 1h & 30m reminders (best effort)
      void applyEventDoubleReminders(title, isoStart);

      await answerQuery("⚡ 1h & 30m alerts set (Telegram + Calendar)!");
      const text = `✅ <b>Double Coverage Active</b> for <b>${escapeTelegramHtml(title)}</b>\n• 1h before &amp; 30m before reminders scheduled.`;
      await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
      return;
    }

    // 2. remind:<MINS>:<ISO_START>:<TITLE>
    if (action.startsWith("remind:")) {
      const rest = action.slice("remind:".length);
      const firstColon = rest.indexOf(":");
      const mins = firstColon > 0 ? parseInt(rest.slice(0, firstColon), 10) : 15;
      const dateAndTitle = firstColon > 0 ? rest.slice(firstColon + 1) : rest;
      const { isoStart, title } = parseIsoAndTitle(dateAndTitle);

      const start = new Date(isoStart);
      const remindTime = new Date(start.getTime() - mins * 60 * 1000);
      if (remindTime.getTime() > Date.now()) {
        addJob({
          name: `Reminder (${mins}m before): ${title}`,
          cronExpr: `${remindTime.getMinutes()} ${remindTime.getHours()} ${remindTime.getDate()} ${remindTime.getMonth() + 1} *`,
          message: `Reminder: "${title}" starts in ${mins} minutes!`,
          channel: "telegram",
          sender,
          oneShot: true,
          mode: "reminder",
        });
      }

      await answerQuery(`⚡ Reminder set (${mins}m before)`);
      const text = `✅ Reminder scheduled for <b>${escapeTelegramHtml(title)}</b> (${mins} minutes before).`;
      await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
      return;
    }

    // 3. job_delete:<JOB_ID>
    if (action.startsWith("job_delete:")) {
      const jobId = action.slice("job_delete:".length).trim();
      removeJob(jobId);
      await answerQuery("🗑️ Scheduled job removed");
      await bot.api.sendMessage(chatId, `🗑️ Scheduled job <code>${escapeTelegramHtml(jobId)}</code> removed.`, { parse_mode: "HTML" });
      return;
    }

    // 4. job_run:<JOB_ID>
    if (action.startsWith("job_run:")) {
      const jobId = action.slice("job_run:".length).trim();
      const job = triggerJob(jobId);
      await answerQuery("▶️ Triggered job");
      await bot.api.sendMessage(chatId, `▶️ Triggered scheduled job: <b>${escapeTelegramHtml(job?.name || jobId)}</b>`, { parse_mode: "HTML" });
      return;
    }

    // 5. email_seen:<EMAIL_KEY>
    if (action.startsWith("email_seen:")) {
      await answerQuery("✅ Marked as seen / archived");
      await bot.api.sendMessage(chatId, "✅ Marked item as seen.", { parse_mode: "HTML" });
      return;
    }

    // 6. ask:<PROMPT> or general prompt
    const prompt = action.startsWith("ask:") ? action.slice(4).trim() : action.trim();
    if (prompt && handler) {
      await answerQuery("⚡ Working on it...");
      const msg: IncomingMessage = {
        channel: "telegram",
        sender,
        senderName,
        text: prompt,
        timestamp: Date.now(),
        raw: ctx,
      };
      const reply = createReplyFn(chatId);
      try {
        await handler(msg, reply);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[telegram] Action handler error: ${errMsg}`);
        try {
          await bot.api.sendMessage(chatId, `Error: ${errMsg}`);
        } catch {}
      }
      return;
    }

    await answerQuery("Done");
  }

  /**
   * Download a Telegram file by file_id and save to disk.
   */
  async function downloadFile(
    fileId: string,
    fileName: string
  ): Promise<string | null> {
    if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });

    try {
      const file = await bot.api.getFile(fileId);
      if (!file.file_path) return null;

      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) return null;

      const buffer = Buffer.from(await res.arrayBuffer());
      const filePath = join(MEDIA_DIR, fileName);
      writeFileSync(filePath, buffer);
      console.log(`[telegram] Saved media: ${filePath}`);
      return filePath;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[telegram] Media download failed: ${errMsg}`);
      return null;
    }
  }

  // Middleware to catch Bot API 10.4 widget_query updates
  bot.use(async (ctx, next) => {
    const update = ctx.update as any;
    if (update && update.widget_query) {
      const wq = update.widget_query;
      const queryId = wq.id;
      let rawAction = wq.data || "";
      if (!rawAction && wq.payload) {
        if (typeof wq.payload === "string") {
          try {
            const parsed = JSON.parse(wq.payload);
            rawAction = parsed.action || wq.payload;
          } catch {
            rawAction = wq.payload;
          }
        } else if (typeof wq.payload === "object" && wq.payload.action) {
          rawAction = wq.payload.action;
        }
      }
      const chatId = wq.chat?.id || wq.message?.chat?.id || wq.from?.id;
      const fromUser = wq.from;
      const sender = fromUser?.username ? `@${fromUser.username}` : String(fromUser?.id || chatId);
      const senderName = fromUser
        ? fromUser.first_name + (fromUser.last_name ? ` ${fromUser.last_name}` : "")
        : "";

      const answerQuery = async (text: string) => {
        try {
          const rawApi = (bot.api as any).raw;
          if (rawApi && typeof rawApi.answerWidgetQuery === "function") {
            await rawApi.answerWidgetQuery({
              widget_query_id: queryId,
              text,
            });
          }
        } catch (err) {
          console.warn(`[telegram] answerWidgetQuery error:`, err);
        }
      };

      await handleInteractiveAction({
        action: rawAction,
        chatId,
        sender,
        senderName,
        answerQuery,
        ctx,
      });
      return;
    }
    await next();
  });

  // Handle standard callback_query updates
  bot.on("callback_query:data", async (ctx) => {
    const rawAction = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id || ctx.callbackQuery.message?.chat?.id || ctx.from.id;
    const fromUser = ctx.from;
    const sender = fromUser?.username ? `@${fromUser.username}` : String(fromUser?.id || chatId);
    const senderName = fromUser
      ? fromUser.first_name + (fromUser.last_name ? ` ${fromUser.last_name}` : "")
      : "";

    const answerQuery = async (text: string) => {
      try {
        await ctx.answerCallbackQuery({ text });
      } catch (err) {
        console.warn(`[telegram] answerCallbackQuery error:`, err);
      }
    };

    await handleInteractiveAction({
      action: rawAction,
      chatId,
      sender,
      senderName,
      answerQuery,
      ctx,
    });
  });

  /**
   * Handle any message type — text, voice, photo, video, document, audio, sticker.
   */
  bot.on("message", async (ctx) => {
    if (!handler) return;

    const sender = ctx.from?.username
      ? `@${ctx.from.username}`
      : String(ctx.from?.id);

    // Check allowlist (empty = allow all)
    if (
      config.allowFrom.length > 0 &&
      !config.allowFrom.includes(sender)
    ) {
      return;
    }

    // Track sender → chatId for outbound file sends
    chatIdMap.set(sender, ctx.chat.id);

    // Send typing indicator immediately
    try {
      await ctx.replyWithChatAction("typing");
    } catch {
      // best-effort
    }

    const attachments: Attachment[] = [];
    let text = ctx.message?.text || ctx.message?.caption || "";

    // Voice message
    if (ctx.message?.voice) {
      const v = ctx.message.voice;
      const name = `${Date.now()}.ogg`;
      const filePath = await downloadFile(v.file_id, name);
      if (filePath) {
        attachments.push({
          type: "voice",
          filePath,
          mimeType: v.mime_type || "audio/ogg",
          duration: v.duration,
        });
      }
    }

    // Audio message
    if (ctx.message?.audio) {
      const a = ctx.message.audio;
      const ext = a.mime_type?.split("/").pop() || "mp3";
      const name = a.file_name || `${Date.now()}.${ext}`;
      const filePath = await downloadFile(a.file_id, name);
      if (filePath) {
        attachments.push({
          type: "audio",
          filePath,
          mimeType: a.mime_type || undefined,
          fileName: a.file_name || undefined,
          duration: a.duration,
        });
      }
    }

    // Photo — pick the largest resolution
    if (ctx.message?.photo && ctx.message.photo.length > 0) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1]!;
      const name = `${Date.now()}.jpg`;
      const filePath = await downloadFile(photo.file_id, name);
      if (filePath) {
        attachments.push({
          type: "image",
          filePath,
          mimeType: "image/jpeg",
        });
      }
    }

    // Video
    if (ctx.message?.video) {
      const v = ctx.message.video;
      const ext = v.mime_type?.split("/").pop() || "mp4";
      const name = v.file_name || `${Date.now()}.${ext}`;
      const filePath = await downloadFile(v.file_id, name);
      if (filePath) {
        attachments.push({
          type: "video",
          filePath,
          mimeType: v.mime_type || undefined,
          fileName: v.file_name || undefined,
          duration: v.duration,
        });
      }
    }

    // Document
    if (ctx.message?.document) {
      const d = ctx.message.document;
      const name = d.file_name || `${Date.now()}.bin`;
      const filePath = await downloadFile(d.file_id, name);
      if (filePath) {
        attachments.push({
          type: "document",
          filePath,
          mimeType: d.mime_type || undefined,
          fileName: d.file_name || undefined,
        });
      }
    }

    // Sticker
    if (ctx.message?.sticker) {
      const s = ctx.message.sticker;
      const name = `${Date.now()}.webp`;
      const filePath = await downloadFile(s.file_id, name);
      if (filePath) {
        attachments.push({
          type: "sticker",
          filePath,
          mimeType: "image/webp",
        });
      }
    }

    // Video note (round video)
    if (ctx.message?.video_note) {
      const vn = ctx.message.video_note;
      const name = `${Date.now()}.mp4`;
      const filePath = await downloadFile(vn.file_id, name);
      if (filePath) {
        attachments.push({
          type: "video",
          filePath,
          mimeType: "video/mp4",
          duration: vn.duration,
        });
      }
    }

    // Skip if nothing to process
    if (!text && attachments.length === 0) return;

    // Default text for media-only messages
    if (!text && attachments.length > 0) {
      text = `[Sent ${attachments[0]!.type}]`;
    }

    const msg: IncomingMessage = {
      channel: "telegram",
      sender,
      senderName:
        ctx.from?.first_name +
        (ctx.from?.last_name ? ` ${ctx.from.last_name}` : ""),
      text,
      timestamp: ctx.message!.date * 1000,
      attachments: attachments.length > 0 ? attachments : undefined,
      raw: ctx,
    };

    const reply = createReplyFn(ctx.chat.id);

    try {
      await handler(msg, reply);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[telegram] Handler error: ${errMsg}`);
      try {
        await ctx.reply(`Error: ${errMsg}`);
      } catch {}
    }
  });

  return {
    name: "telegram",

    async start() {
      console.log("[telegram] Starting bot...");

      // Init first to validate token before returning
      await bot.init();
      console.log(`[telegram] Bot initialized: @${bot.botInfo.username}`);

      // Register senders so agent and tools can deliver messages, files, and widgets
      registerChannelSender("telegram", {
        async sendText({ recipient, text }) {
          const chatId = resolveChatId(recipient);
          await sendTextWithFallback(chatId, text);
        },

        async sendFile({ recipient, filePath, caption }) {
          const chatId = resolveChatId(recipient);
          const mediaType = detectMediaType(filePath);
          const file = new InputFile(filePath);

          switch (mediaType) {
            case "image":
              await bot.api.sendPhoto(chatId, file, { caption });
              break;
            case "video":
              await bot.api.sendVideo(chatId, file, { caption });
              break;
            case "audio":
              await bot.api.sendAudio(chatId, file, { caption });
              break;
            default:
              await bot.api.sendDocument(chatId, file, { caption });
              break;
          }
          console.log(`[telegram] Sent ${mediaType} to ${recipient}`);
        },

        async sendWidget({ recipient, html, chatData, fallbackText, buttons }) {
          const chatId = resolveChatId(recipient);
          await clearActiveHud(chatId);
          const res = await sendWidgetMessage(chatId, {
            html,
            chatData,
            fallbackText,
            buttons,
          });
          return { messageId: res.messageId };
        },

        async updateWidget({ recipient, messageId, chatData, fallbackText, buttons }) {
          const chatId = resolveChatId(recipient);
          const isNative = nativeWidgetsByMsgId.get(messageId) ?? false;
          await updateWidgetMessage(chatId, messageId, isNative, {
            chatData,
            fallbackText,
            buttons,
          });
        },
      });

      // Start polling in background (resolves when bot stops)
      bot.start({
        allowed_updates: ["message", "callback_query", "widget_query"] as any,
        onStart: () => console.log("[telegram] Polling started"),
      }).catch((err) => {
        console.error(`[telegram] Polling error: ${err}`);
      });
    },

    async stop() {
      await bot.stop();
      console.log("[telegram] Bot stopped");
    },

    onMessage(h) {
      handler = h;
    },

    async handleUpdate(update: any) {
      await bot.handleUpdate(update);
    },
  };
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }
  return chunks;
}
