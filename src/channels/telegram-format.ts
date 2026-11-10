import type { WidgetButtonSpec } from "./registry.ts";

export type WidgetCardItem = {
  label: string;
  value: string;
  badge?: string;
  tone?: "default" | "accent" | "success" | "warn" | "danger";
};

export type WidgetCardSpec = {
  title: string;
  subtitle?: string;
  badge?: string;
  sections?: Array<{
    heading?: string;
    body?: string;
    items?: WidgetCardItem[];
  }>;
  items?: WidgetCardItem[];
  customHtml?: string;
  actions?: WidgetButtonSpec[];
  footer?: string;
};

export type LiveStatusState = {
  phase: "thinking" | "working" | "tool" | "done" | "error";
  currentStep: string;
  steps: string[];
  startedAt: number;
  elapsedSec?: number;
};

/**
 * Escapes characters that are reserved in Telegram HTML format (&, <, >).
 */
export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeTelegramHtml(text).replace(/"/g, "&quot;");
}

/**
 * Converts GitHub Flavored Markdown to valid Telegram Bot API parse_mode: "HTML".
 * 
 * Telegram supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="...">, <blockquote>.
 * 
 * Rules:
 * 1. Extract fenced code blocks and replace with placeholders (rendered as <pre><code>...escaped...</code></pre>).
 * 2. Extract inline code spans and replace with placeholders (rendered as <code>...escaped...</code>).
 * 3. Escape HTML entities (& -> &amp;, < -> &lt;, > -> &gt;) in remaining text.
 * 4. Convert markdown links [label](url), stripping backticks/code placeholders inside label so nested code never breaks entities.
 * 5. Structural line conversions:
 *    - Headings ^\s*#{1,6}\s+(.+)$ -> <b>$1</b>
 *    - Blockquotes ^\s*&gt;\s?(.*)$ -> <blockquote>...</blockquote> (consecutive lines merged)
 *    - Bullets ^(\s*)[*-]\s+(.+)$ -> $1• $2 (before bold/italic parsing to prevent triple-asterisk collisions)
 * 6. Inline formatting:
 *    - Bold **text** or __text__ -> <b>text</b>
 *    - Strikethrough ~~text~~ -> <s>text</s>
 *    - Italic *text* (single asterisk not adjacent to spaces) -> <i>text</i>
 *    - Italic _text_ ONLY when surrounded by whitespace or punctuation boundaries
 * 7. Restore code placeholders.
 */
export function formatTelegramHtml(markdown: string): string {
  if (!markdown) return "";

  // 1. Extract fenced code blocks
  const fencedBlocks: string[] = [];
  const fencedRegex = /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g;
  let text = markdown.replace(fencedRegex, (_match, _lang, code) => {
    const cleanCode = code.replace(/\r?\n$/, "");
    const escaped = escapeTelegramHtml(cleanCode);
    const placeholder = `@@TGFENCE${fencedBlocks.length}@@`;
    fencedBlocks.push(`<pre><code>${escaped}</code></pre>`);
    return placeholder;
  });

  // 2. Extract inline code spans
  const inlineCodes: { html: string; raw: string }[] = [];
  const inlineRegex = /(`+)(.+?)\1/g;
  text = text.replace(inlineRegex, (_match, _ticks, content) => {
    let clean = content;
    if (clean.startsWith(" ") && clean.endsWith(" ") && clean.trim().length > 0) {
      clean = clean.slice(1, -1);
    }
    const escaped = escapeTelegramHtml(clean);
    const placeholder = `@@TGCODE${inlineCodes.length}@@`;
    inlineCodes.push({
      html: `<code>${escaped}</code>`,
      raw: escaped,
    });
    return placeholder;
  });

  // 3. Escape HTML entities in remaining text
  text = escapeTelegramHtml(text);

  // 4. Convert Markdown links [label](url)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  text = text.replace(linkRegex, (_match, label, url) => {
    let cleanLabel = label.replace(/@@TGCODE(\d+)@@/g, (_m: string, id: string) => {
      const idx = Number(id);
      return inlineCodes[idx] ? inlineCodes[idx].raw : "";
    });
    cleanLabel = cleanLabel.replace(/`/g, "");

    let cleanUrl = url.trim();
    if (cleanUrl.startsWith("&lt;") && cleanUrl.endsWith("&gt;")) {
      cleanUrl = cleanUrl.slice(4, -4).trim();
    }
    cleanUrl = cleanUrl.replace(/"/g, "&quot;");

    return `<a href="${cleanUrl}">${cleanLabel}</a>`;
  });

  // 5. Line-by-line structural conversions
  text = processStructuralLines(text);

  // 6. Inline formatting on non-code text
  // Bold **text**
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");

  // Bold __text__
  text = text.replace(/(?<=^|[\s(])__([^_\n]+?)__(?=$|[\s.,!?:;)])/g, "<b>$1</b>");

  // Strikethrough ~~text~~
  text = text.replace(/~~([^~\n]+?)~~/g, "<s>$1</s>");

  // Italic *text* (single asterisk not adjacent to spaces)
  text = text.replace(/(?<!\*)\*([^\*\s\n](?:[^\*\n]*?[^\*\s\n])?)\*(?!\*)/g, "<i>$1</i>");

  // Italic _text_ (surrounded by whitespace or punctuation boundaries, protecting snake_case and emails)
  text = text.replace(/(?<=^|[\s(])_([^_\n]+?)_(?=$|[\s.,!?:;)])/g, "<i>$1</i>");

  // 7. Restore placeholders
  text = text.replace(/@@TGCODE(\d+)@@/g, (_m, id) => {
    const idx = Number(id);
    return inlineCodes[idx] ? inlineCodes[idx].html : "";
  });

  text = text.replace(/@@TGFENCE(\d+)@@/g, (_m, id) => {
    const idx = Number(id);
    return fencedBlocks[idx] ? fencedBlocks[idx] : "";
  });

  return text;
}

function processStructuralLines(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let blockquoteBuffer: string[] | null = null;

  function flushBlockquote() {
    if (blockquoteBuffer !== null) {
      result.push(`<blockquote>${blockquoteBuffer.join("\n")}</blockquote>`);
      blockquoteBuffer = null;
    }
  }

  function formatLine(line: string): string {
    const hrMatch = line.match(/^\s*(?:---|___|\*\*\*|- - -|\* \* \*)\s*$/);
    if (hrMatch) {
      return "──────────";
    }
    const headingMatch = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (headingMatch && headingMatch[1] !== undefined) {
      const headingContent = headingMatch[1].replace(/\s+#+$/, "");
      return `<b>${headingContent}</b>`;
    }
    const bulletMatch = line.match(/^(\s*)[*-]\s+(.+)$/);
    if (bulletMatch) {
      return `${bulletMatch[1] ?? ""}• ${bulletMatch[2] ?? ""}`;
    }
    return line;
  }

  for (const line of lines) {
    const bqMatch = line.match(/^\s*&gt;\s?(.*)$/);
    if (bqMatch) {
      if (blockquoteBuffer === null) {
        blockquoteBuffer = [];
      }
      blockquoteBuffer.push(formatLine(bqMatch[1] ?? ""));
    } else {
      flushBlockquote();
      result.push(formatLine(line));
    }
  }
  flushBlockquote();
  return result.join("\n");
}

/**
 * Builds an interactive Telegram Dark Mode Bot API 10.4 HTML widget.
 */
export function buildInteractiveWidget(spec: WidgetCardSpec): {
  html: string;
  chatData: Record<string, unknown>;
  fallbackHtml: string;
  buttons: WidgetButtonSpec[][];
} {
  const chatData: Record<string, unknown> = {
    title: spec.title,
    subtitle: spec.subtitle ?? null,
    statusBadge: spec.badge ?? null,
    completedActions: [],
    timestamp: Date.now(),
  };

  const buttons: WidgetButtonSpec[][] = [];
  if (spec.actions && spec.actions.length > 0) {
    for (let i = 0; i < spec.actions.length; i += 2) {
      buttons.push(spec.actions.slice(i, i + 2));
    }
  }

  // Build fallback HTML
  const fallbackLines: string[] = [];
  let header = `<b>${escapeTelegramHtml(spec.title)}</b>`;
  if (spec.badge) {
    header += ` [<code>${escapeTelegramHtml(spec.badge)}</code>]`;
  }
  fallbackLines.push(header);
  if (spec.subtitle) {
    fallbackLines.push(`<i>${escapeTelegramHtml(spec.subtitle)}</i>`);
  }

  function appendFallbackItems(items: WidgetCardItem[]) {
    for (const item of items) {
      let line = `• <b>${escapeTelegramHtml(item.label)}</b>: ${escapeTelegramHtml(item.value)}`;
      if (item.badge) {
        line += ` [<code>${escapeTelegramHtml(item.badge)}</code>]`;
      }
      fallbackLines.push(line);
    }
  }

  if (spec.items && spec.items.length > 0) {
    if (spec.subtitle) fallbackLines.push("");
    appendFallbackItems(spec.items);
  }

  if (spec.sections && spec.sections.length > 0) {
    for (const sec of spec.sections) {
      if (sec.heading) {
        fallbackLines.push(`\n<b>${escapeTelegramHtml(sec.heading)}</b>`);
      }
      if (sec.body) {
        fallbackLines.push(formatTelegramHtml(sec.body));
      }
      if (sec.items && sec.items.length > 0) {
        appendFallbackItems(sec.items);
      }
    }
  }

  if (
    spec.customHtml &&
    (!spec.sections || spec.sections.length === 0) &&
    (!spec.items || spec.items.length === 0)
  ) {
    const stripped = spec.customHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (stripped) {
      fallbackLines.push(escapeTelegramHtml(stripped));
    }
  }

  if (spec.footer) {
    fallbackLines.push(`\n<i>${escapeTelegramHtml(spec.footer)}</i>`);
  }

  const fallbackHtml = fallbackLines.join("\n").replace(/\n{3,}/g, "\n\n");

  // Build Dark Mode HTML document (< 8 KB, well under 32 KB)
  const badgeClass = spec.badge ? "badge badge-accent" : "";
  const badgeHtml = spec.badge
    ? `<span id="widget-badge" class="${badgeClass}">${escapeTelegramHtml(spec.badge)}</span>`
    : `<span id="widget-badge" class="badge" style="display:none"></span>`;

  let bodyContentHtml = "";
  if (spec.customHtml) {
    bodyContentHtml = `<div class="custom-body">${spec.customHtml}</div>`;
  } else {
    let itemsHtml = "";
    if (spec.items && spec.items.length > 0) {
      itemsHtml = renderItemsGrid(spec.items);
    }

    let sectionsHtml = "";
    if (spec.sections && spec.sections.length > 0) {
      sectionsHtml = spec.sections
        .map((sec) => {
          let s = `<div class="section-block">`;
          if (sec.heading) {
            s += `<div class="section-heading">${escapeTelegramHtml(sec.heading)}</div>`;
          }
          if (sec.body) {
            s += `<div class="section-body">${formatTelegramHtml(sec.body)}</div>`;
          }
          if (sec.items && sec.items.length > 0) {
            s += renderItemsGrid(sec.items);
          }
          s += `</div>`;
          return s;
        })
        .join("");
    }

    bodyContentHtml = `${itemsHtml}${sectionsHtml}`;
  }

  let actionsHtml = "";
  if (spec.actions && spec.actions.length > 0) {
    const actionBtns = spec.actions
      .map((btn) => {
        if (btn.url) {
          return `<a class="btn" href="${escapeAttr(btn.url)}" target="_blank" rel="noopener">${escapeTelegramHtml(btn.label)}</a>`;
        }
        return `<button class="btn" data-action="${escapeAttr(btn.action)}" onclick="triggerAction('${escapeAttr(btn.action)}', this)">${escapeTelegramHtml(btn.label)}</button>`;
      })
      .join("");
    actionsHtml = `<div class="actions-grid">${actionBtns}</div>`;
  }

  const footerHtml = spec.footer
    ? `<div class="footer">${escapeTelegramHtml(spec.footer)}</div>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg-color: #0e1621;
  --card-bg: #17212b;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background-color: #17212b;
  color: #f5f5f5;
  padding: 0;
  margin: 0;
  line-height: 1.45;
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
}
.widget-card {
  background: #17212b;
  border: 1px solid #242f3d;
  border-radius: 12px;
  padding: 12px 14px;
}
.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}
.title-wrap { flex: 1; min-width: 0; }
.title {
  font-size: 15px;
  font-weight: 600;
  color: #f5f5f5;
  word-break: break-word;
}
.subtitle {
  font-size: 12px;
  color: #8a9aa9;
  margin-top: 2px;
}
.badge {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  white-space: nowrap;
}
.badge-default { background: rgba(138,154,169,0.18); color: #8a9aa9; }
.badge-accent { background: rgba(106,178,242,0.18); color: #6ab2f2; border: 1px solid rgba(106,178,242,0.3); }
.badge-success { background: rgba(78,204,94,0.18); color: #4ecc5e; border: 1px solid rgba(78,204,94,0.3); }
.badge-warn { background: rgba(245,166,35,0.18); color: #f5a623; border: 1px solid rgba(245,166,35,0.3); }
.badge-danger { background: rgba(255,89,90,0.18); color: #ff595a; border: 1px solid rgba(255,89,90,0.3); }

.items-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.item-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  background: rgba(36,47,61,0.5);
  border-radius: 8px;
  font-size: 13px;
  gap: 8px;
}
.item-label { color: #8a9aa9; flex-shrink: 0; }
.item-val-wrap { display: flex; align-items: center; gap: 6px; min-width: 0; text-align: right; }
.item-val { color: #f5f5f5; font-weight: 500; word-break: break-word; }

.section-block {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid #242f3d;
}
.section-heading {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #6ab2f2;
  font-weight: 600;
  margin-bottom: 4px;
}
.section-body {
  color: #d1d7dd;
  font-size: 13px;
  line-height: 1.4;
}

.actions-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 8px;
  margin-top: 14px;
}
.btn {
  background: #2b5278;
  color: #ffffff;
  border: none;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  text-align: center;
  text-decoration: none;
  transition: all 0.15s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.btn:hover { background: #366695; }
.btn:active { transform: scale(0.98); }
.btn-working { background: #242f3d !important; color: #8a9aa9 !important; cursor: not-allowed; }
.btn-done { background: rgba(78,204,94,0.2) !important; color: #4ecc5e !important; border: 1px solid rgba(78,204,94,0.4); }

.footer {
  margin-top: 10px;
  font-size: 11px;
  color: #8a9aa9;
  text-align: right;
}
</style>
</head>
<body>
<div class="widget-card">
  <div class="header">
    <div class="title-wrap">
      <div class="title">${escapeTelegramHtml(spec.title)}</div>
      ${spec.subtitle ? `<div class="subtitle">${escapeTelegramHtml(spec.subtitle)}</div>` : ""}
    </div>
    ${badgeHtml}
  </div>
  ${bodyContentHtml}
  ${actionsHtml}
  ${footerHtml}
</div>
<script>
(function() {
  window.triggerAction = function(action, btnEl) {
    if (btnEl && (btnEl.classList.contains('btn-working') || btnEl.classList.contains('btn-done'))) return;
    if (btnEl) {
      btnEl.dataset.originalText = btnEl.innerText;
      btnEl.innerText = "⚡ Working...";
      btnEl.classList.add('btn-working');
    }
    var payload = { action: action, timestamp: Date.now() };
    try {
      if (window.TelegramWidget && typeof window.TelegramWidget.request === 'function') {
        try {
          window.TelegramWidget.request(action);
        } catch (_) {
          window.TelegramWidget.request(payload);
        }
      } else {
        console.log("[TelegramWidget bridge] Action:", action, payload);
      }
    } catch (e) {
      console.error("[TelegramWidget bridge] Error:", e);
    }
  };

  function applyDataUpdates(data) {
    if (!data) return;
    if (data.statusBadge) {
      var badgeEl = document.getElementById("widget-badge");
      if (badgeEl) {
        badgeEl.innerText = String(data.statusBadge);
        badgeEl.style.display = "inline-block";
      }
    }
    if (Array.isArray(data.completedActions)) {
      document.querySelectorAll("[data-action]").forEach(function(el) {
        var act = el.getAttribute("data-action");
        if (data.completedActions.indexOf(act) !== -1) {
          el.innerText = "✓ Done";
          el.className = "btn btn-done";
        }
      });
    }
  }

  function handleData(raw) {
    if (!raw && window.TelegramWidget && window.TelegramWidget.chatData) {
      raw = window.TelegramWidget.chatData;
    }
    if (!raw && window.CHAT_DATA) {
      raw = window.CHAT_DATA;
    }
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch (e) {
        return;
      }
    }
    if (raw && typeof raw === "object") {
      applyDataUpdates(raw);
    }
  }

  window.CHAT_DATA = ${JSON.stringify(chatData)};

  if (window.TelegramWidget) {
    if (typeof window.TelegramWidget.onEvent === "function") {
      window.TelegramWidget.onEvent("chatDataChanged", function(evtData) {
        handleData(evtData);
      });
    }
    if (typeof window.TelegramWidget.onDataUpdated === "function") {
      window.TelegramWidget.onDataUpdated(function(data) {
        handleData(data);
      });
    }
  }
  handleData();
})();
</script>
</body>
</html>`;

  return {
    html,
    chatData,
    fallbackHtml,
    buttons,
  };
}

function renderItemsGrid(items: WidgetCardItem[]): string {
  const rows = items
    .map((item) => {
      const tone = item.tone || "default";
      const badgeHtml = item.badge
        ? `<span class="badge badge-${tone}">${escapeTelegramHtml(item.badge)}</span>`
        : "";
      return `<div class="item-row">
        <span class="item-label">${escapeTelegramHtml(item.label)}</span>
        <div class="item-val-wrap">
          <span class="item-val">${escapeTelegramHtml(item.value)}</span>
          ${badgeHtml}
        </div>
      </div>`;
    })
    .join("");
  return `<div class="items-grid">${rows}</div>`;
}

/**
 * Builds a compact Telegram Dark Mode Live Execution HUD widget.
 */
export function buildLiveStatusWidget(state: LiveStatusState): {
  html: string;
  chatData: Record<string, unknown>;
  fallbackHtml: string;
} {
  const elapsedSec =
    state.elapsedSec !== undefined
      ? state.elapsedSec
      : Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));

  function formatDuration(sec: number): string {
    if (sec < 60) return `${sec}s`;
    const mins = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${mins}m ${rem < 10 ? "0" : ""}${rem}s`;
  }

  const elapsedText = formatDuration(elapsedSec);

  type PhaseConfig = {
    color: string;
    badge: string;
    icon: string;
    pulsing: boolean;
  };

  const phaseConfigs: Record<LiveStatusState["phase"], PhaseConfig> = {
    thinking: { color: "#6ab2f2", badge: "THINKING", icon: "🧠", pulsing: true },
    working: { color: "#6ab2f2", badge: "WORKING", icon: "⚡", pulsing: true },
    tool: { color: "#f5a623", badge: "TOOL", icon: "🔧", pulsing: true },
    done: { color: "#4ecc5e", badge: "DONE", icon: "✓", pulsing: false },
    error: { color: "#ff595a", badge: "ERROR", icon: "✗", pulsing: false },
  };

  const cfg = phaseConfigs[state.phase] || phaseConfigs.working;

  const chatData: Record<string, unknown> = {
    phase: state.phase,
    currentStep: state.currentStep,
    steps: state.steps,
    startedAt: state.startedAt,
    elapsedSec,
    timestamp: Date.now(),
  };

  // Fallback HTML
  let fallbackHtml = `<b>${cfg.icon} Status:</b> ${escapeTelegramHtml(state.currentStep)} (<code>${elapsedText}</code>)`;
  if (state.steps && state.steps.length > 0) {
    const stepsList = state.steps
      .map((s, idx) => {
        const isLast = idx === state.steps.length - 1;
        const prefix = isLast && state.phase !== "done" && state.phase !== "error" ? "⚡" : "✓";
        return `• ${prefix} ${escapeTelegramHtml(s)}`;
      })
      .join("\n");
    fallbackHtml += `\n${stepsList}`;
  }

  // HTML Widget (< 8 KB)
  const stepsTrailHtml = (state.steps || [])
    .map((s, idx) => {
      const isCurrent = idx === state.steps.length - 1;
      const isPast = !isCurrent;
      const stepIcon =
        isCurrent && state.phase !== "done" && state.phase !== "error" ? "⚡" : "✓";
      const iconClass = isPast || state.phase === "done" ? "icon-done" : "icon-current";
      return `<div class="step-item ${isCurrent ? "step-current" : ""}">
        <span class="step-icon ${iconClass}">${stepIcon}</span>
        <span class="step-text">${escapeTelegramHtml(s)}</span>
      </div>`;
    })
    .join("");

  const isLive = state.phase !== "done" && state.phase !== "error";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg-color: #0e1621;
  --card-bg: #17212b;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background-color: #17212b;
  color: #f5f5f5;
  padding: 0;
  margin: 0;
  line-height: 1.45;
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
}
.hud-card {
  background: #17212b;
  border: 1px solid #242f3d;
  border-radius: 12px;
  padding: 10px 12px;
}
.hud-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.status-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
@keyframes pulse {
  0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(106, 178, 242, 0.7); }
  70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(106, 178, 242, 0); }
  100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(106, 178, 242, 0); }
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background-color: ${cfg.color};
  flex-shrink: 0;
}
.dot-pulsing {
  animation: pulse 1.6s infinite;
}
.current-step {
  font-size: 13px;
  font-weight: 600;
  color: #f5f5f5;
  word-break: break-word;
}
.hud-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.timer-pill {
  font-size: 11px;
  color: #8a9aa9;
  background: rgba(36,47,61,0.6);
  padding: 2px 7px;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.badge {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 6px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  background: rgba(106, 178, 242, 0.15);
  color: ${cfg.color};
  border: 1px solid ${cfg.color}40;
}
.step-trail {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid #242f3d;
}
.step-item {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: #8a9aa9;
}
.step-current {
  color: #f5f5f5;
  font-weight: 500;
}
.step-icon {
  font-size: 11px;
  width: 14px;
  text-align: center;
}
.icon-done { color: #4ecc5e; }
.icon-current { color: #6ab2f2; }
</style>
</head>
<body>
<div class="hud-card">
  <div class="hud-header">
    <div class="status-left">
      <div id="status-dot" class="dot ${cfg.pulsing ? "dot-pulsing" : ""}"></div>
      <span id="current-step-label" class="current-step">${escapeTelegramHtml(state.currentStep)}</span>
    </div>
    <div class="hud-right">
      <span id="elapsed-timer" class="timer-pill">${elapsedText}</span>
      <span id="hud-badge" class="badge">${cfg.badge}</span>
    </div>
  </div>
  <div class="step-trail"${stepsTrailHtml ? "" : ' style="display:none"'}>${stepsTrailHtml}</div>
</div>
<script>
(function() {
  var isLive = ${isLive};
  var startedAt = ${state.startedAt};
  var timerEl = document.getElementById("elapsed-timer");

  function fmtSec(sec) {
    if (sec < 60) return sec + "s";
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + "m " + (s < 10 ? "0" : "") + s + "s";
  }

  if (isLive && timerEl && startedAt > 0) {
    setInterval(function() {
      var elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      timerEl.innerText = fmtSec(elapsed);
    }, 1000);
  }

  function applyDataUpdates(data) {
    if (!data) return;
    if (data.currentStep) {
      var labelEl = document.getElementById("current-step-label");
      if (labelEl) labelEl.innerText = String(data.currentStep);
    }
    if (Array.isArray(data.steps)) {
      var trailEl = document.querySelector(".step-trail");
      if (!trailEl) {
        trailEl = document.createElement("div");
        trailEl.className = "step-trail";
        var card = document.querySelector(".hud-card");
        if (card) card.appendChild(trailEl);
      }
      var isDone = data.phase === "done" || data.phase === "error";
      var items = "";
      for (var i = 0; i < data.steps.length; i++) {
        var s = String(data.steps[i]);
        var isCurrent = (i === data.steps.length - 1);
        var isPast = !isCurrent;
        var stepIcon = (isCurrent && !isDone) ? "⚡" : "✓";
        var iconClass = (isPast || isDone) ? "icon-done" : "icon-current";
        items += '<div class="step-item' + (isCurrent ? ' step-current' : '') + '">' +
          '<span class="step-icon ' + iconClass + '">' + stepIcon + '</span>' +
          '<span class="step-text">' + s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + '</span>' +
        '</div>';
      }
      trailEl.innerHTML = items;
      trailEl.style.display = "flex";
    }
    if (data.phase) {
      var phaseColors = {
        thinking: "#6ab2f2",
        working: "#6ab2f2",
        tool: "#f5a623",
        done: "#4ecc5e",
        error: "#ff595a"
      };
      var phaseBadges = {
        thinking: "THINKING",
        working: "WORKING",
        tool: "TOOL",
        done: "DONE",
        error: "ERROR"
      };
      var color = phaseColors[data.phase] || "#6ab2f2";
      var badgeText = phaseBadges[data.phase] || String(data.phase).toUpperCase();

      var dotEl = document.getElementById("status-dot");
      if (dotEl) {
        dotEl.style.backgroundColor = color;
        if (data.phase === "done" || data.phase === "error") {
          dotEl.classList.remove("dot-pulsing");
        } else {
          dotEl.classList.add("dot-pulsing");
        }
      }

      var badgeEl = document.getElementById("hud-badge");
      if (badgeEl) {
        badgeEl.innerText = badgeText;
        badgeEl.style.color = color;
        badgeEl.style.borderColor = color + "40";
      }
    }
  }

  function handleData(raw) {
    if (!raw && window.TelegramWidget && window.TelegramWidget.chatData) {
      raw = window.TelegramWidget.chatData;
    }
    if (!raw && window.CHAT_DATA) {
      raw = window.CHAT_DATA;
    }
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch (e) {
        return;
      }
    }
    if (raw && typeof raw === "object") {
      applyDataUpdates(raw);
    }
  }

  window.CHAT_DATA = ${JSON.stringify(chatData)};

  if (window.TelegramWidget) {
    if (typeof window.TelegramWidget.onEvent === "function") {
      window.TelegramWidget.onEvent("chatDataChanged", function(evtData) {
        handleData(evtData);
      });
    }
    if (typeof window.TelegramWidget.onDataUpdated === "function") {
      window.TelegramWidget.onDataUpdated(function(data) {
        handleData(data);
      });
    }
  }
  handleData();
})();
</script>
</body>
</html>`;

  return {
    html,
    chatData,
    fallbackHtml,
  };
}
