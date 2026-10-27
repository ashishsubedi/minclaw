import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  jidNormalizedUser,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import type { Attachment, ChannelAdapter, IncomingMessage, ReplyFn } from "./types.ts";
import type { ChannelConfig } from "../config.ts";
import { registerChannelSender, detectMediaType } from "./registry.ts";

let latestQr: string | null = null;
let latestQrSvg: string | null = null;
let currentConnectionState: "open" | "connecting" | "waiting_for_qr" | "close" = "close";
let activePairingSocket: WASocket | null = null;
let activeSocketGeneration = 0;

export function isWhatsAppPaired(): boolean {
  const authDir = resolve(import.meta.dir, "../../.wa-auth");
  const credsPath = join(authDir, "creds.json");
  if (!existsSync(credsPath)) return false;
  try {
    const raw = readFileSync(credsPath, "utf-8");
    const creds = JSON.parse(raw);
    return Boolean(creds?.me?.id);
  } catch {
    return false;
  }
}

export function resetWhatsAppAuth(): void {
  activeSocketGeneration++;
  const authDir = resolve(import.meta.dir, "../../.wa-auth");
  if (existsSync(authDir)) {
    try {
      rmSync(authDir, { recursive: true, force: true });
      console.log("[whatsapp] Cleared auth credentials in .wa-auth/");
    } catch (err) {
      console.error("[whatsapp] Failed to clear .wa-auth:", err);
    }
  }
  if (activePairingSocket) {
    try {
      activePairingSocket.end(undefined);
    } catch {}
    activePairingSocket = null;
  }
  latestQr = null;
  latestQrSvg = null;
  currentConnectionState = "close";
}

export function getWhatsAppChannelStatus() {
  const paired = isWhatsAppPaired();
  return {
    state: paired ? (currentConnectionState === "close" ? "open" : currentConnectionState) : currentConnectionState,
    paired,
    qr: paired ? null : latestQr,
    qrSvg: paired ? null : latestQrSvg,
  };
}

export async function requestWhatsAppPairing(options?: { force?: boolean }): Promise<{ ok: boolean; qrSvg?: string; paired: boolean }> {
  const authDir = resolve(import.meta.dir, "../../.wa-auth");

  if (options?.force) {
    resetWhatsAppAuth();
  }

  // If already genuinely paired and registered with WhatsApp server:
  if (isWhatsAppPaired()) {
    currentConnectionState = "open";
    latestQr = null;
    latestQrSvg = null;
    return { ok: true, paired: true };
  }

  // If an active QR already exists and socket is alive, return it
  if (latestQrSvg && activePairingSocket) {
    return { ok: true, qrSvg: latestQrSvg, paired: false };
  }

  if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const generation = ++activeSocketGeneration;

  return new Promise((resolvePromise) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolvePromise({ ok: true, qrSvg: latestQrSvg || undefined, paired: false });
      }
    }, 8000);

    function startSocket() {
      if (generation !== activeSocketGeneration) return;

      if (activePairingSocket) {
        try {
          activePairingSocket.end(undefined);
        } catch {}
      }

      currentConnectionState = "connecting";
      activePairingSocket = makeWASocket({
        version,
        auth: state,
        browser: ["MinClaw", "Chrome", "1.0.0"],
        printQRInTerminal: false,
      });

      activePairingSocket.ev.on("creds.update", (credsUpdate) => {
        saveCreds();
        if (credsUpdate.me?.id) {
          currentConnectionState = "open";
          latestQr = null;
          latestQrSvg = null;
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolvePromise({ ok: true, paired: true });
          }
        }
      });

      activePairingSocket.ev.on("connection.update", async (update) => {
        if (generation !== activeSocketGeneration) return;

        const { connection, lastDisconnect, qr } = update;
        if (qr && !isWhatsAppPaired()) {
          latestQr = qr;
          currentConnectionState = "waiting_for_qr";
          try {
            latestQrSvg = await QRCode.toString(qr, { type: "svg", margin: 1, width: 256 });
          } catch {}
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolvePromise({ ok: true, qrSvg: latestQrSvg || undefined, paired: false });
          }
        }

        if (connection === "open" || isWhatsAppPaired()) {
          currentConnectionState = "open";
          latestQr = null;
          latestQrSvg = null;
          console.log("[whatsapp] WhatsApp pairing handshake complete! Connection is OPEN.");
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolvePromise({ ok: true, paired: true });
          }
        }

        if (connection === "close") {
          if (generation !== activeSocketGeneration) return;
          if (isWhatsAppPaired()) {
            currentConnectionState = "open";
            return;
          }

          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          console.log(`[whatsapp] Pairing socket closed (code ${statusCode}). Reconnect allowed: ${shouldReconnect}`);

          if (shouldReconnect) {
            console.log("[whatsapp] Stream restart required. Reconnecting to complete WhatsApp login handshake...");
            setTimeout(() => {
              if (generation === activeSocketGeneration && !isWhatsAppPaired()) {
                startSocket();
              }
            }, 1000);
          } else {
            console.log("[whatsapp] Pairing session logged out or rejected by server.");
            currentConnectionState = "close";
            activePairingSocket = null;
            resetWhatsAppAuth();
          }
        }
      });
    }

    startSocket();
  });
}

const MEDIA_DIR = resolve(import.meta.dir, "../../media/whatsapp");

const MEDIA_TYPES = [
  "audioMessage",
  "imageMessage",
  "videoMessage",
  "documentMessage",
  "stickerMessage",
] as const;

type MediaType = (typeof MEDIA_TYPES)[number];

function mediaTypeToAttachment(type: MediaType): Attachment["type"] {
  switch (type) {
    case "audioMessage": return "audio";
    case "imageMessage": return "image";
    case "videoMessage": return "video";
    case "documentMessage": return "document";
    case "stickerMessage": return "sticker";
  }
}

function extensionForType(type: MediaType, mimetype?: string | null): string {
  if (mimetype) {
    const ext = mimetype.split("/").pop()?.split(";")[0];
    if (ext && ext !== "octet-stream") return `.${ext.replace("x-", "")}`;
  }
  switch (type) {
    case "audioMessage": return ".ogg";
    case "imageMessage": return ".jpg";
    case "videoMessage": return ".mp4";
    case "documentMessage": return ".bin";
    case "stickerMessage": return ".webp";
  }
}

/**
 * Extract text and media info from a WhatsApp message.
 */
function extractContent(msg: WAMessage): {
  text: string;
  mediaType?: MediaType;
  caption?: string;
  mimetype?: string | null;
  ptt?: boolean;
  fileName?: string | null;
  duration?: number;
} {
  const m = msg.message;
  if (!m) return { text: "" };

  // Plain text
  if (m.conversation) return { text: m.conversation };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text };

  // Media messages
  for (const type of MEDIA_TYPES) {
    const media = m[type];
    if (media) {
      const isVoice = type === "audioMessage" && (media as any).ptt;
      return {
        text: (media as any).caption || "",
        mediaType: type,
        caption: (media as any).caption || undefined,
        mimetype: (media as any).mimetype,
        ptt: isVoice,
        fileName: type === "documentMessage" ? (media as any).fileName : undefined,
        duration: (media as any).seconds,
      };
    }
  }

  return { text: "" };
}

/**
 * Download media from a message and save to disk.
 */
async function saveMedia(
  msg: WAMessage,
  mediaType: MediaType,
  mimetype?: string | null,
  fileName?: string | null
): Promise<string | null> {
  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });

  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {});
    const name = fileName || `${Date.now()}${extensionForType(mediaType, mimetype)}`;
    const filePath = join(MEDIA_DIR, name);
    writeFileSync(filePath, buffer as Buffer);
    console.log(`[whatsapp] Saved media: ${filePath}`);
    return filePath;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[whatsapp] Media download failed: ${errMsg}`);
    return null;
  }
}

export function createWhatsAppAdapter(
  config: ChannelConfig,
  onConnected?: () => void
): ChannelAdapter {
  let sock: WASocket | null = null;
  let handler: ((msg: IncomingMessage, reply: ReplyFn) => void) | null = null;
  const authDir = resolve(import.meta.dir, "../../.wa-auth");

  return {
    name: "whatsapp",

    async start() {
      console.log("[whatsapp] Starting...");
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      const connect = () => {
        sock = makeWASocket({
          version,
          auth: state,
          browser: ["MinClaw", "Chrome", "1.0.0"],
        });

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", (update) => {
          const { connection, lastDisconnect, qr } = update;

          // Display QR code when received
          if (qr) {
            latestQr = qr;
            currentConnectionState = "waiting_for_qr";
            QRCode.toString(qr, { type: "svg", margin: 1, width: 256 })
              .then((svg) => { latestQrSvg = svg; })
              .catch(() => {});
            console.log("\n[whatsapp] Scan this QR code with WhatsApp:\n");
            qrcode.generate(qr, { small: true });
            console.log();
          }

          if (connection === "close") {
            currentConnectionState = "close";
            const statusCode = (lastDisconnect?.error as any)?.output
              ?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
              console.log(`[whatsapp] Disconnected (code ${statusCode}). Reconnecting in 1s...`);
              setTimeout(connect, 1000);
            } else {
              console.log("[whatsapp] Logged out");
            }
          } else if (connection === "open") {
          currentConnectionState = "open";
          latestQr = null;
          latestQrSvg = null;
          console.log("[whatsapp] Connected");

          // Register file sender so agent can send images/files back
          const currentSock = sock!;
          registerChannelSender("whatsapp", {
            async sendText({ recipient, text }) {
              await currentSock.sendMessage(recipient, { text });
            },

            async sendFile({ recipient, filePath, caption }) {
              const mediaType = detectMediaType(filePath);
              const buffer = readFileSync(filePath);

              switch (mediaType) {
                case "image":
                  await currentSock.sendMessage(recipient, { image: buffer, caption });
                  break;
                case "video":
                  await currentSock.sendMessage(recipient, { video: buffer, caption });
                  break;
                case "audio":
                  await currentSock.sendMessage(recipient, { audio: buffer, ptt: false });
                  break;
                default:
                  await currentSock.sendMessage(recipient, {
                    document: buffer,
                    mimetype: "application/octet-stream",
                    fileName: basename(filePath),
                    caption,
                  });
                  break;
              }
              console.log(`[whatsapp] Sent ${mediaType} to ${recipient}`);
            },
          });

          onConnected?.();
        }
      });

      const botSentMessageIds = new Set<string>();

      sock.ev.on("messages.upsert", async ({ messages }) => {
        if (!handler || !sock) return;

        for (const msg of messages) {
          if (!msg.message || !sock) continue;
          if (msg.key.id && botSentMessageIds.has(msg.key.id)) {
            botSentMessageIds.delete(msg.key.id);
            continue;
          }

          const sender = msg.key.remoteJid || "";
          const myJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : "";
          const senderJid = sender ? jidNormalizedUser(sender) : "";
          const myPhone = myJid ? myJid.split("@")[0] || "" : "";
          const isSelfChat = Boolean(myJid && senderJid && (myJid === senderJid || (myPhone && sender.includes(myPhone))));

          // Protect privacy: if msg is sent by user to another contact or group, ignore it.
          // Only process if it's sent to self ("Message yourself") or received from an allowed contact.
          if (msg.key.fromMe && !isSelfChat) continue;

          // Check allowlist (self-chat is always allowed)
          if (
            !isSelfChat &&
            config.allowFrom.length > 0 &&
            !config.allowFrom.some((a) => sender.includes(a.replace("+", "")))
          ) {
            continue;
          }

          const content = extractContent(msg);

          // Skip if no text and no media
          if (!content.text && !content.mediaType) continue;

          // Send typing indicator immediately
          const currentSock = sock;
          try {
            await currentSock.sendPresenceUpdate("composing", sender);
          } catch {
            // Typing indicator is best-effort
          }

          // Download media if present
          const attachments: Attachment[] = [];
          if (content.mediaType) {
            const filePath = await saveMedia(
              msg,
              content.mediaType,
              content.mimetype,
              content.fileName,
            );
            if (filePath) {
              attachments.push({
                type: content.ptt ? "voice" : mediaTypeToAttachment(content.mediaType),
                filePath,
                mimeType: content.mimetype || undefined,
                fileName: content.fileName || undefined,
                duration: content.duration,
                caption: content.caption,
              });
            }
          }

          // Build text for agent — include attachment context
          let text = content.text;
          if (attachments.length > 0 && !text) {
            text = `[Sent ${attachments[0]!.type}]`;
          }

          const incoming: IncomingMessage = {
            channel: "whatsapp",
            sender,
            senderName: msg.pushName || sender,
            text,
            timestamp: (msg.messageTimestamp as number) * 1000,
            attachments: attachments.length > 0 ? attachments : undefined,
            raw: msg,
          };

          const reply: ReplyFn = async (replyText: string) => {
            // Stop typing indicator
            try {
              await currentSock.sendPresenceUpdate("paused", sender);
            } catch {
              // best-effort
            }
            const sent = await currentSock.sendMessage(sender, { text: replyText });
            if (sent?.key?.id) {
              botSentMessageIds.add(sent.key.id);
              if (botSentMessageIds.size > 200) {
                const first = botSentMessageIds.values().next().value;
                if (first) botSentMessageIds.delete(first);
              }
            }
          };

          try {
            await handler(incoming, reply);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[whatsapp] Handler error: ${errMsg}`);
            try {
              const errSent = await currentSock.sendMessage(sender, { text: `Error: ${errMsg}` });
              if (errSent?.key?.id) botSentMessageIds.add(errSent.key.id);
            } catch {}
          }
        }
      });
    };

    connect();
  },

    async stop() {
      sock?.end(undefined);
      sock = null;
      console.log("[whatsapp] Stopped");
    },

    onMessage(h) {
      handler = h;
    },
  };
}
