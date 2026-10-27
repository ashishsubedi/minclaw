// MinClaw Studio Web Dashboard Controller (macOS Studio Edition)
(() => {
  "use strict";

  // DOM Elements
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => document.querySelectorAll(selector);

  // Global State
  let state = {
    overview: null,
    sessions: [],
    activeSessionKey: null,
    activeTab: "overview",
    emailAccounts: [],
    permanentMemory: null,
    rawConfig: "",
  };

  // Toast Notifications
  function showToast(message, type = "info") {
    const container = $("#toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(12px)";
      setTimeout(() => toast.remove(), 250);
    }, 3500);
  }

  // API Fetch Helper
  async function fetchJSON(url, options = {}) {
    try {
      const res = await fetch(url, options);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      return data;
    } catch (err) {
      console.error(`fetchJSON error for ${url}:`, err);
      throw err;
    }
  }

  // Format Helpers
  function formatUptime(seconds) {
    if (!seconds && seconds !== 0) return "--";
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${seconds % 60}s`;
  }

  function formatTime(timestamp) {
    if (!timestamp) return "--";
    const d = new Date(timestamp);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Tab Navigation & Hash Routing
  const titles = {
    overview: "Overview",
    sessions: "Sessions & Activity",
    memory: "Permanent Memory",
    integrations: "Integrations & Connected Services",
    scheduler: "Scheduler",
    config: "Configuration",
  };

  function switchTab(tabId) {
    if (!titles[tabId]) tabId = "overview";
    state.activeTab = tabId;
    window.location.hash = tabId;

    $$(".nav-btn").forEach((btn) => {
      if (btn.getAttribute("data-tab") === tabId) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });

    $$("section[id^='page-']").forEach((sec) => {
      sec.classList.add("hidden");
    });

    const activeSec = $(`#page-${tabId}`);
    if (activeSec) activeSec.classList.remove("hidden");

    const titleEl = $("#currentViewTitle");
    if (titleEl) titleEl.textContent = titles[tabId];

    if (tabId === "memory" && !state.permanentMemory) {
      loadPermanentMemory();
    } else if (tabId === "config" && !state.rawConfig) {
      loadConfigRaw();
    } else if (tabId === "integrations") {
      loadEmailAccounts();
      refreshWhatsAppStatus();
    }
  }

  window.switchTab = switchTab;

  function initRouting() {
    const hash = window.location.hash.replace(/^#/, "");
    switchTab(hash || "overview");

    window.addEventListener("hashchange", () => {
      const h = window.location.hash.replace(/^#/, "");
      if (h && h !== state.activeTab) {
        switchTab(h);
      }
    });

    $$(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-tab");
        if (tab) switchTab(tab);
      });
    });
  }

  // Pinned Dock Handler
  function openExtensionManager() {
    switchTab("integrations");
    showIntegrationSub("extensions");
    const extCard = $("#voiceMacExtensionCard");
    if (extCard) {
      extCard.scrollIntoView({ behavior: "smooth" });
      extCard.style.boxShadow = "0 0 0 2px var(--accent-blue)";
      setTimeout(() => {
        extCard.style.boxShadow = "";
      }, 1800);
    }
  }
  window.openExtensionManager = openExtensionManager;

  // Subnav filtering for Integrations
  function showIntegrationSub(filter) {
    $$(".subnav-btn").forEach((btn) => {
      if (btn.textContent.toLowerCase().includes(filter) || (filter === "all" && btn.textContent === "All")) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });

    const mail = $("#sub-mail");
    const channels = $("#sub-channels");
    const extensions = $("#sub-extensions");

    if (filter === "all") {
      if (mail) mail.classList.remove("hidden");
      if (channels) channels.classList.remove("hidden");
      if (extensions) extensions.classList.remove("hidden");
    } else if (filter === "mail") {
      if (mail) mail.classList.remove("hidden");
      if (channels) channels.classList.add("hidden");
      if (extensions) extensions.classList.add("hidden");
    } else if (filter === "channels") {
      if (mail) mail.classList.add("hidden");
      if (channels) channels.classList.remove("hidden");
      if (extensions) extensions.classList.add("hidden");
    } else if (filter === "extensions") {
      if (mail) mail.classList.add("hidden");
      if (channels) channels.classList.add("hidden");
      if (extensions) extensions.classList.remove("hidden");
    }
  }
  window.showIntegrationSub = showIntegrationSub;

  // Overview Data Loading
  async function loadOverview() {
    try {
      const data = await fetchJSON("/api/overview");
      state.overview = data;
      renderOverview();
      renderScheduler();
    } catch (err) {
      console.warn("Could not load overview:", err);
    }
  }

  function renderOverview() {
    const o = state.overview;
    if (!o) return;

    // Header & Daemon Status
    const isDaemon = o.daemon?.running;
    const dot = $("#daemonStatusDot");
    const txt = $("#daemonStatusText");
    if (dot) dot.className = `status-dot ${isDaemon ? "dot-green" : "dot-amber"}`;
    if (txt) txt.textContent = isDaemon ? `Online • PID ${o.daemon.pid || "--"}` : "Daemon Idle";

    // Pinned Dock Status
    const dockRss = $("#dockDaemonRss");
    const dockUptime = $("#dockUptime");
    const dockDot = $("#dockExtensionDot");
    if (dockRss) dockRss.textContent = `${o.daemon?.memoryRssMb ?? 42} MB`;
    if (dockUptime) dockUptime.textContent = formatUptime(o.daemon?.uptimeSeconds);

    const voiceExt = (o.extensions || []).find((e) => e.id === "voice-mac");
    if (dockDot) {
      dockDot.className = `status-dot ${voiceExt?.status === "running" ? "dot-green" : "dot-dim"}`;
    }

    // Native Extension Card in Integrations
    const extPidBadge = $("#extVoicePidBadge");
    const extVoiceDot = $("#extVoiceDot");
    if (extPidBadge) {
      if (voiceExt?.pid) {
        extPidBadge.textContent = `PID: ${voiceExt.pid}`;
        extPidBadge.className = "badge badge-blue font-mono";
      } else {
        extPidBadge.textContent = "Offline";
        extPidBadge.className = "badge font-mono";
      }
    }
    if (extVoiceDot) {
      extVoiceDot.className = `status-dot ${voiceExt?.status === "running" ? "dot-green" : "dot-dim"}`;
    }

    // 4 Metrics Cards
    const spendEl = $("#statTotalSpend");
    const tokensEl = $("#statTotalTokens");
    const rssEl = $("#statMemoryRss");
    const uptimeEl = $("#statUptime");
    const sessEl = $("#statActiveSessions");
    const jobsCountEl = $("#navJobCount");
    const sessCountEl = $("#navSessionCount");

    const cost = o.sessions?.usage?.costTotal || 0;
    const totalTokens = o.sessions?.usage?.totalTokens || 0;
    if (spendEl) spendEl.textContent = `$${cost.toFixed(4)}`;
    if (tokensEl) tokensEl.textContent = `${totalTokens.toLocaleString()} tokens`;

    if (rssEl) rssEl.textContent = `${o.daemon?.memoryRssMb ?? 42} MB`;
    if (uptimeEl) uptimeEl.textContent = `Uptime: ${formatUptime(o.daemon?.uptimeSeconds)}`;

    const totalSessions = o.sessions?.total || 0;
    if (sessEl) sessEl.textContent = `${totalSessions} Sessions`;
    if (sessCountEl) sessCountEl.textContent = String(totalSessions);

    const totalJobs = (o.jobs || []).length;
    if (jobsCountEl) jobsCountEl.textContent = String(totalJobs);

    // Recent Activity in Overview
    renderOverviewActivity(o.sessions?.active || []);

    // Next Scheduled Task
    const nextBox = $("#overviewNextJobBox");
    if (nextBox) {
      const upcomingJob = (o.jobs || []).find((j) => j.nextRunAt);
      if (upcomingJob) {
        const nextTime = new Date(upcomingJob.nextRunAt).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        nextBox.innerHTML = `
          <div class="flex justify-between items-center text-xs">
            <span class="font-bold text-white">${escapeHtml(upcomingJob.name || upcomingJob.message)}</span>
            <span class="badge badge-blue font-mono">${escapeHtml(upcomingJob.cronExpr)}</span>
          </div>
          <div class="text-xs text-muted font-mono">Next: ${nextTime} (${upcomingJob.mode || "auto"} mode)</div>
        `;
      } else {
        nextBox.innerHTML = `<div class="text-xs text-muted">No scheduled jobs registered.</div>`;
      }
    }
  }

  function renderOverviewActivity(sessions) {
    const list = $("#overviewActivityList");
    if (!list) return;

    if (!sessions || sessions.length === 0) {
      list.innerHTML = `<div class="p-4 text-center text-muted">No recent activity detected.</div>`;
      return;
    }

    list.innerHTML = sessions.slice(0, 3).map((sess) => {
      const isVoice = sess.channel === "terminal" || sess.key.includes("voice");
      const isTelegram = sess.channel === "telegram";
      const badgeClass = isVoice ? "badge-green" : isTelegram ? "badge-blue" : "badge-purple";
      const channelLabel = isVoice ? "Voice HUD" : isTelegram ? "Telegram" : escapeHtml(sess.channel);

      return `
        <div class="card-subtle p-3.5 space-y-2 cursor-pointer hover:border-slate-500 transition" onclick="openSpecificSession('${escapeHtml(sess.key)}')">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="badge ${badgeClass} font-mono">${channelLabel}</span>
              <span class="font-mono text-xs text-muted">${escapeHtml(sess.key)}</span>
            </div>
            <span class="font-mono text-xs text-dim">${formatTime(sess.lastActive)}</span>
          </div>
          <p class="text-xs text-white" style="line-height:1.5;">${escapeHtml(sess.preview || "Active interaction")}</p>
          <div class="flex items-center justify-between text-xs pt-1">
            <span class="font-mono text-dim">${sess.messageCount} turns • ${(sess.usage?.totalTokens || 0).toLocaleString()} tokens</span>
            <span class="text-blue font-semibold">Jump to session →</span>
          </div>
        </div>
      `;
    }).join("");
  }

  // Sessions Tab
  async function loadSessions() {
    try {
      const data = await fetchJSON("/api/sessions");
      state.sessions = data.sessions || [];
      const headerCount = $("#sessionsListHeaderCount");
      if (headerCount) headerCount.textContent = `${data.total || state.sessions.length} total`;
      renderSessionsList();
    } catch (err) {
      console.warn("Could not load sessions:", err);
    }
  }

  // Markdown Formatter for Chat
  function formatMarkdown(text) {
    if (!text) return "";
    let html = escapeHtml(text);

    // Fenced code blocks ```lang ... ```
    html = html.replace(/```([a-zA-Z0-9_\-\.]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      return `<pre><code class="language-${lang || "plaintext"}">${code.trim()}</code></pre>`;
    });

    // Inline code `code`
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

    // Headings
    html = html.replace(/^#### (.*$)/gim, "<h4>$1</h4>");
    html = html.replace(/^### (.*$)/gim, "<h3>$1</h3>");
    html = html.replace(/^## (.*$)/gim, "<h2>$1</h2>");
    html = html.replace(/^# (.*$)/gim, "<h1>$1</h1>");

    // Blockquotes
    html = html.replace(/^\> (.*$)/gim, "<blockquote>$1</blockquote>");

    // Horizontal rule
    html = html.replace(/^---$/gim, "<hr/>");

    // Bold & italic
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^\*])\*([^\*\n]+)\*([^\*]|$)/g, "$1<em>$2</em>$3");
    html = html.replace(/(^|[^_])_([^_\n]+)_([^_]|$)/g, "$1<em>$2</em>$3");

    // Markdown links [text](url)
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-blue underline">$1</a>');

    // Bullet lists
    html = html.replace(/^(?:[-*] )(.*)$/gim, "<li>$1</li>");
    html = html.replace(/((?:<li>.*<\/li>\s*)+)/gim, "<ul>$1</ul>");

    // Numbered lists
    html = html.replace(/^(?:\d+\. )(.*)$/gim, '<li class="list-decimal">$1</li>');
    html = html.replace(/((?:<li class="list-decimal">.*<\/li>\s*)+)/gim, "<ol>$1</ol>");

    // Paragraphs & line breaks
    const parts = html.split(/(<pre[\s\S]*?<\/pre>|<ul[\s\S]*?<\/ul>|<ol[\s\S]*?<\/ol>|<blockquote[\s\S]*?<\/blockquote>|<h[1-4]>.*?<\/h[1-4]>|<hr\/>)/);
    html = parts.map((part) => {
      if (
        part.startsWith("<pre") ||
        part.startsWith("<ul") ||
        part.startsWith("<ol") ||
        part.startsWith("<blockquote") ||
        part.startsWith("<h") ||
        part.startsWith("<hr")
      ) {
        return part;
      }
      return part
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
        .join("");
    }).join("");

    return html;
  }

  function scrollToChatBottom() {
    const turnsBody = $("#sessionTurnsBody");
    if (turnsBody) {
      setTimeout(() => {
        turnsBody.scrollTop = turnsBody.scrollHeight;
      }, 20);
    }
  }

  function autoResizeTextarea(el) {
    if (!el) return;
    el.style.height = "auto";
    const newHeight = Math.min(el.scrollHeight, 120);
    el.style.height = `${Math.max(42, newHeight)}px`;
  }

  function getChannelMeta(sessionKey) {
    const idx = (sessionKey || "").indexOf(":");
    const channel = idx > 0 ? sessionKey.slice(0, idx) : "web";
    const sender = idx > 0 ? sessionKey.slice(idx + 1) : sessionKey;

    switch (channel) {
      case "telegram":
        return { channel, sender, icon: "✈️", badgeClass: "badge-blue", name: `Telegram: ${sender}` };
      case "whatsapp":
        return { channel, sender, icon: "💬", badgeClass: "badge-green", name: `WhatsApp: ${sender}` };
      case "voice":
        return { channel, sender, icon: "🎙️", badgeClass: "badge-purple", name: "Voice HUD Companion" };
      case "web":
      default:
        return {
          channel: "web",
          sender,
          icon: "💻",
          badgeClass: "badge-blue",
          name: sender === "web-dashboard" ? "Web Dashboard Chat" : `Web (${sender})`,
        };
    }
  }

  function renderSessionsList() {
    const container = $("#sessionsListContainer");
    if (!container) return;

    if (state.sessions.length === 0) {
      container.innerHTML = `<div class="p-4 text-center text-muted">No active sessions.</div>`;
      return;
    }

    container.innerHTML = state.sessions.map((sess) => {
      const meta = getChannelMeta(sess.key);
      const isSelected = sess.key === state.activeSessionKey;
      const activeClass = isSelected ? "card active" : "card-subtle";
      const borderStyle = isSelected ? "border-color: var(--accent-blue); background-color: rgba(10, 132, 255, 0.08);" : "";
      
      return `
        <div class="${activeClass} p-3 cursor-pointer space-y-1.5" style="${borderStyle}" onclick="selectSession('${escapeHtml(sess.key)}')">
          <div class="flex justify-between items-center">
            <div class="flex items-center gap-1.5 overflow-hidden">
              <span class="text-xs">${meta.icon}</span>
              <span class="font-bold text-white text-xs truncate" style="max-width: 140px;">${escapeHtml(meta.name)}</span>
            </div>
            <span class="font-mono text-xs text-green">$${(sess.usage?.costTotal || 0).toFixed(3)}</span>
          </div>
          <p class="text-xs text-muted truncate">${escapeHtml(sess.preview || "No message preview")}</p>
          <div class="flex justify-between items-center text-xs font-mono text-dim pt-0.5">
            <span class="badge ${meta.badgeClass} text-xs font-mono" style="padding: 1px 5px; font-size: 10px;">${escapeHtml(meta.channel)}</span>
            <div class="flex items-center gap-2">
              <span>${sess.messageCount} turns</span>
              <span>${formatTime(sess.lastActive)}</span>
            </div>
          </div>
        </div>
      `;
    }).join("");

    // Auto-select first session if none selected
    if (!state.activeSessionKey && state.sessions[0]) {
      selectSession(state.sessions[0].key);
    }
  }

  async function selectSession(sessionKey) {
    state.activeSessionKey = sessionKey;
    renderSessionsList();

    const meta = getChannelMeta(sessionKey);
    const header = $("#activeSessionHeader");
    const sub = $("#activeSessionSub");
    const badge = $("#activeSessionTokensBadge");
    const channelBadge = $("#activeSessionChannelBadge");
    const avatar = $("#activeSessionAvatar");
    const turnsBody = $("#sessionTurnsBody");

    if (header) header.textContent = meta.name;
    if (sub) sub.textContent = `sessions/${sessionKey}.jsonl`;
    if (channelBadge) {
      channelBadge.className = `badge font-mono ${meta.badgeClass}`;
      channelBadge.textContent = meta.channel;
    }
    if (avatar) {
      avatar.textContent = meta.icon;
    }

    if (turnsBody) {
      turnsBody.innerHTML = `<div class="p-8 text-center text-muted">Loading conversation transcript...</div>`;
    }

    try {
      const detail = await fetchJSON(`/api/sessions/${encodeURIComponent(sessionKey)}`);
      if (badge) {
        const costStr = detail.usage?.costTotal ? ` • $${detail.usage.costTotal.toFixed(4)}` : "";
        badge.textContent = `${(detail.usage?.totalTokens || 0).toLocaleString()} tokens${costStr}`;
      }
      if (sub && detail.messages) {
        sub.textContent = `${detail.messages.length} messages • sessions/${sessionKey}.jsonl`;
      }
      renderSessionTurns(detail.messages || []);
      scrollToChatBottom();
    } catch (err) {
      if (turnsBody) {
        turnsBody.innerHTML = `<div class="p-8 text-center text-red">Failed to load session: ${escapeHtml(err.message)}</div>`;
      }
    }
  }
  window.selectSession = selectSession;

  function renderToolCallsList(toolCalls) {
    if (!toolCalls || toolCalls.length === 0) return "";
    const toolNames = toolCalls.map((tc) => tc.name).join(", ");
    const count = toolCalls.length;

    return `
      <details class="tool-accordion">
        <summary class="tool-summary-pill">
          <span>🔧</span>
          <span class="text-purple font-medium">${count} tool${count > 1 ? "s" : ""} executed</span>
          <span class="text-dim">(${escapeHtml(toolNames)})</span>
          <span class="text-dim ml-1">▾</span>
        </summary>
        <div class="tool-details-content space-y-2">
          ${toolCalls.map((tc) => `
            <div class="p-2 rounded bg-black/50 border border-white/5 space-y-1">
              <div class="flex justify-between items-center text-xs font-bold text-purple font-mono">
                <span>🔧 ${escapeHtml(tc.name)}</span>
              </div>
              ${tc.input ? `
                <div class="text-dim text-xs">Input:</div>
                <pre class="text-xs p-1.5 rounded bg-black/60 overflow-x-auto"><code>${escapeHtml(typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input, null, 2))}</code></pre>
              ` : ""}
              ${tc.output ? `
                <div class="text-dim text-xs">Output:</div>
                <pre class="text-xs p-1.5 rounded bg-black/60 overflow-x-auto text-green"><code>${escapeHtml(typeof tc.output === "string" ? (tc.output.length > 500 ? tc.output.slice(0, 500) + "..." : tc.output) : JSON.stringify(tc.output, null, 2))}</code></pre>
              ` : ""}
            </div>
          `).join("")}
        </div>
      </details>
    `;
  }

  function renderSessionTurns(messages) {
    const turnsBody = $("#sessionTurnsBody");
    if (!turnsBody) return;

    if (!messages || messages.length === 0) {
      turnsBody.innerHTML = `
        <div class="p-12 text-center text-muted space-y-2">
          <div style="font-size: 32px;">💬</div>
          <div class="font-bold text-white text-sm">Start a conversation with MinClaw</div>
          <div class="text-xs text-muted max-w-sm mx-auto">Send instructions, trigger tasks, or query your memory directly from this chat window.</div>
        </div>
      `;
      return;
    }

    turnsBody.innerHTML = messages.map((msg) => {
      const isUser = msg.role === "user";

      if (isUser) {
        return `
          <div class="chat-msg chat-msg-user">
            <div class="chat-bubble chat-bubble-user">
              <div class="markdown-body">${formatMarkdown(msg.content)}</div>
            </div>
            <div class="flex items-center gap-1.5 text-dim font-mono text-xs mt-1 mr-1">
              <span>${formatTime(msg.timestamp)}</span>
              ${msg.usage?.totalTokens ? `<span>• ${msg.usage.totalTokens} tok</span>` : ""}
            </div>
          </div>
        `;
      }

      // Assistant or System turn
      const toolCallsHtml = renderToolCallsList(msg.toolCalls);
      const hasContent = Boolean(msg.content && msg.content.trim());

      return `
        <div class="chat-msg chat-msg-assistant">
          <div class="flex items-center gap-2 mb-1 ml-1">
            <div class="w-5 h-5 rounded-full flex items-center justify-center text-xs" style="background-color: var(--accent-blue-soft); border: 1px solid var(--accent-blue); width: 20px; height: 20px;">
              <span style="font-size: 11px;">🤖</span>
            </div>
            <span class="font-bold text-white text-xs">MinClaw</span>
            <span class="text-dim font-mono text-xs">${formatTime(msg.timestamp)}</span>
            ${msg.usage?.totalTokens ? `<span class="badge badge-purple text-xs font-mono" style="padding: 1px 5px; font-size: 10px;">${msg.usage.totalTokens} tok</span>` : ""}
          </div>
          ${toolCallsHtml}
          ${hasContent ? `
            <div class="chat-bubble chat-bubble-assistant">
              <div class="markdown-body">${formatMarkdown(msg.content)}</div>
            </div>
          ` : ""}
        </div>
      `;
    }).join("");
  }

  function appendUserBubble(text, timestamp = Date.now()) {
    const turnsBody = $("#sessionTurnsBody");
    if (!turnsBody) return;

    // Remove empty placeholder if present
    const emptyNotice = turnsBody.querySelector(".text-center");
    if (emptyNotice) emptyNotice.remove();

    const bubbleHtml = `
      <div class="chat-msg chat-msg-user">
        <div class="chat-bubble chat-bubble-user">
          <div class="markdown-body">${formatMarkdown(text)}</div>
        </div>
        <div class="flex items-center gap-1.5 text-dim font-mono text-xs mt-1 mr-1">
          <span>${formatTime(timestamp)}</span>
        </div>
      </div>
    `;
    turnsBody.insertAdjacentHTML("beforeend", bubbleHtml);
  }

  function showThinkingIndicator() {
    const turnsBody = $("#sessionTurnsBody");
    if (!turnsBody) return;
    removeThinkingIndicator();

    const indicatorHtml = `
      <div id="chatThinkingIndicator" class="chat-msg chat-msg-assistant">
        <div class="chat-thinking">
          <span class="pulse-dot"></span>
          <span>MinClaw is thinking...</span>
        </div>
      </div>
    `;
    turnsBody.insertAdjacentHTML("beforeend", indicatorHtml);
  }

  function removeThinkingIndicator() {
    const el = $("#chatThinkingIndicator");
    if (el) el.remove();
  }

  function appendErrorBubble(errorMessage) {
    const turnsBody = $("#sessionTurnsBody");
    if (!turnsBody) return;
    const errorHtml = `
      <div class="chat-msg chat-msg-assistant">
        <div class="chat-bubble" style="background-color: rgba(255, 69, 58, 0.15); border: 1px solid rgba(255, 69, 58, 0.35); color: #ff8580;">
          <div class="font-bold text-xs">Message Failed</div>
          <div class="text-xs mt-0.5">${escapeHtml(errorMessage)}</div>
        </div>
      </div>
    `;
    turnsBody.insertAdjacentHTML("beforeend", errorHtml);
  }

  async function submitChatMessage(event) {
    if (event) event.preventDefault();
    const input = $("#chatInput");
    const sendBtn = $("#chatSendBtn");
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;

    let targetKey = state.activeSessionKey;
    if (!targetKey) {
      targetKey = "web:web-dashboard";
      state.activeSessionKey = targetKey;
    }

    // Immediately reflect message in chat stream
    appendUserBubble(text);
    input.value = "";
    autoResizeTextarea(input);
    showThinkingIndicator();
    scrollToChatBottom();

    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.textContent = "...";
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          sessionKey: targetKey,
        }),
      });

      const data = await res.json();
      removeThinkingIndicator();

      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to receive response from MinClaw");
      }

      // Reload full session transcript and turn list
      await selectSession(targetKey);
      loadSessions();
    } catch (err) {
      removeThinkingIndicator();
      showToast(`Chat error: ${err.message}`, "error");
      appendErrorBubble(`Failed: ${err.message}`);
      scrollToChatBottom();
    } finally {
      if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send ↵";
      }
      input.focus();
    }
  }
  window.submitChatMessage = submitChatMessage;

  function startNewWebChat() {
    const newKey = `web:chat-${Date.now().toString(36)}`;
    state.activeSessionKey = newKey;
    selectSession(newKey);
    const input = $("#chatInput");
    if (input) input.focus();
  }
  window.startNewWebChat = startNewWebChat;

  function refreshActiveSession() {
    if (state.activeSessionKey) {
      selectSession(state.activeSessionKey);
      showToast("Conversation refreshed", "info");
    }
  }
  window.refreshActiveSession = refreshActiveSession;

  async function deleteActiveSession() {
    const key = state.activeSessionKey;
    if (!key) {
      showToast("No active conversation selected to delete", "info");
      return;
    }
    if (!confirm(`Delete conversation "${key}" and remove its history from disk?`)) {
      return;
    }

    try {
      await fetchJSON(`/api/sessions/${encodeURIComponent(key)}`, { method: "DELETE" });
      showToast("Conversation deleted", "info");
      state.sessions = state.sessions.filter((s) => s.key !== key);
      const totalBadge = $("#sessionsCountBadge");
      if (totalBadge) totalBadge.textContent = `${state.sessions.length} total`;

      if (state.sessions.length > 0) {
        selectSession(state.sessions[0].key);
      } else {
        state.activeSessionKey = null;
        renderSessionsList();
        const header = $("#activeSessionHeader");
        const sub = $("#activeSessionSub");
        const badge = $("#activeSessionTokensBadge");
        const turnsBody = $("#sessionTurnsBody");
        if (header) header.textContent = "No Conversation Selected";
        if (sub) sub.textContent = "Select or start a new conversation";
        if (badge) badge.textContent = "0 tokens";
        if (turnsBody) turnsBody.innerHTML = `<div class="p-12 text-center text-muted">No conversations found. Start a new chat with "+ New Chat".</div>`;
      }
    } catch (err) {
      showToast(`Failed to delete conversation: ${err.message}`, "error");
    }
  }
  window.deleteActiveSession = deleteActiveSession;

  function openSpecificSession(sessionKey) {
    switchTab("sessions");
    selectSession(sessionKey);
  }
  window.openSpecificSession = openSpecificSession;

  // Memory Tab (Permanent Dossier vs Temporary Index)
  let activeMemoryTab = "permanent";

  function switchMemorySub(type) {
    activeMemoryTab = type;
    const btnPerm = $("#memTabBtnPermanent");
    const btnTemp = $("#memTabBtnTemporary");
    const profCard = $("#memoryPermanentProfileCard");
    const secTitle = $("#memorySectionTitle");
    const headerTitle = $("#memoryHeaderTitle");
    const headerSub = $("#memoryHeaderSub");

    if (type === "permanent") {
      if (btnPerm) btnPerm.classList.add("active");
      if (btnTemp) btnTemp.classList.remove("active");
      if (profCard) profCard.classList.remove("hidden");
      if (headerTitle) headerTitle.textContent = "Agent Permanent Memory (Dossier)";
      if (headerSub) headerSub.textContent = "Durable facts & user profile injected into system prompt from brain/permanent-memory.md";
      if (secTitle) secTitle.textContent = "Standing Directives & Learned Facts";
      loadPermanentMemory();
    } else {
      if (btnPerm) btnPerm.classList.remove("active");
      if (btnTemp) btnTemp.classList.add("active");
      if (profCard) profCard.classList.add("hidden");
      if (headerTitle) headerTitle.textContent = "Agent Temporary Memory (Working Index)";
      if (headerSub) headerSub.textContent = "Rolling multi-session context & compaction summaries from memory/temporary-memory.md";
      if (secTitle) secTitle.textContent = "Active Sessions & Recent Working Context";
      loadTemporaryMemory();
    }
  }
  window.switchMemorySub = switchMemorySub;

  async function loadPermanentMemory() {
    const display = $("#memoryContentDisplay");
    const pathLabel = $("#memoryPathLabel");
    if (display) display.textContent = "Loading permanent memory from server...";

    try {
      const data = await fetchJSON("/api/memory/permanent");
      state.permanentMemory = data;
      if (pathLabel) pathLabel.textContent = data.path || "brain/permanent-memory.md";
      if (display) {
        display.textContent = data.content || "No permanent memory file found.";
      }
    } catch (err) {
      if (display) display.textContent = `Error loading permanent memory: ${err.message}`;
    }
  }
  window.loadPermanentMemory = loadPermanentMemory;

  async function loadTemporaryMemory() {
    const display = $("#memoryContentDisplay");
    const pathLabel = $("#memoryPathLabel");
    if (display) display.textContent = "Loading temporary working memory from server...";

    try {
      const data = await fetchJSON("/api/memory/temporary");
      if (pathLabel) pathLabel.textContent = data.path || "memory/temporary-memory.md";
      if (display) {
        display.textContent = data.content || "No temporary memory index found.";
      }
    } catch (err) {
      if (display) display.textContent = `Error loading temporary memory: ${err.message}`;
    }
  }
  window.loadTemporaryMemory = loadTemporaryMemory;

  function reloadActiveMemory() {
    if (activeMemoryTab === "permanent") {
      loadPermanentMemory();
    } else {
      loadTemporaryMemory();
    }
  }
  window.reloadActiveMemory = reloadActiveMemory;

  // Google OAuth
  function openGoogleModal() {
    const m = $("#googleModal");
    if (m) m.classList.remove("hidden");
    checkGoogleConfig();
  }
  window.openGoogleModal = openGoogleModal;

  function closeGoogleModal() {
    const m = $("#googleModal");
    if (m) m.classList.add("hidden");
  }
  window.closeGoogleModal = closeGoogleModal;

  async function checkGoogleConfig() {
    const badge = $("#googleConfigBadge");
    try {
      const data = await fetchJSON("/api/email/google/config");
      if (badge) {
        if (data.configured) {
          badge.textContent = `Configured (${data.clientId || "Custom Client"})`;
          badge.className = "badge badge-green font-mono";
        } else {
          badge.textContent = "Keys Not Set";
          badge.className = "badge badge-amber font-mono";
        }
      }
    } catch (err) {
      if (badge) badge.textContent = "Error checking";
    }
  }

  function toggleGoogleManualKeys() {
    const f = $("#googleKeysForm");
    if (f) f.classList.toggle("hidden");
  }
  window.toggleGoogleManualKeys = toggleGoogleManualKeys;

  async function submitGoogleKeys(e) {
    e.preventDefault();
    const clientId = $("#googleClientId")?.value.trim();
    const clientSecret = $("#googleClientSecret")?.value.trim();
    if (!clientId || !clientSecret) return;

    try {
      await fetchJSON("/api/email/google/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret }),
      });
      showToast("Google OAuth keys saved! Starting Google Sign-In...", "success");
      setTimeout(() => {
        startGoogleOAuthFlow();
      }, 700);
    } catch (err) {
      showToast(`Failed to save Google keys: ${err.message}`, "error");
    }
  }
  window.submitGoogleKeys = submitGoogleKeys;

  function startGoogleOAuthFlow() {
    window.location.href = "/api/auth/google/start";
  }
  window.startGoogleOAuthFlow = startGoogleOAuthFlow;

  // WhatsApp Live QR Pairing
  let waPollTimer = null;

  async function refreshWhatsAppStatus() {
    try {
      const data = await fetchJSON("/api/channels/whatsapp/status");
      const waBadge = $("#waStatusBadge");
      const waSubLabel = $("#waSubLabel");
      if (waBadge) {
        if (data.paired) {
          waBadge.textContent = "Paired";
          waBadge.className = "badge badge-green font-mono";
        } else {
          waBadge.textContent = "Not Paired";
          waBadge.className = "badge badge-dim font-mono";
        }
      }
      if (waSubLabel) {
        waSubLabel.textContent = data.paired
          ? (data.state === "open" ? "State: Connected" : "State: Paired")
          : "State: Unlinked";
      }
    } catch {}
  }
  window.refreshWhatsAppStatus = refreshWhatsAppStatus;

  async function openWhatsAppModal() {
    const m = $("#whatsappModal");
    if (m) m.classList.remove("hidden");
    const qrBox = $("#waQrBox");
    const statusBox = $("#waPairStatus");
    const instructions = $("#waInstructions");
    const actionBtn = $("#waActionBtn");

    if (qrBox) {
      qrBox.className = "flex items-center justify-center p-4 bg-white rounded-xl mx-auto";
      qrBox.style.width = "260px";
      qrBox.style.height = "260px";
      qrBox.innerHTML = `<div class="text-xs text-black font-mono">Checking connection status...</div>`;
    }
    if (statusBox) statusBox.innerHTML = `<span class="status-dot dot-amber"></span><span>Checking...</span>`;

    try {
      const res = await fetchJSON("/api/channels/whatsapp/pair", { method: "POST" });
      if (res.paired) {
        if (instructions) instructions.classList.add("hidden");
        if (qrBox) {
          qrBox.className = "flex flex-col items-center justify-center p-6 bg-card border rounded-xl mx-auto space-y-2 text-center";
          qrBox.style.width = "260px";
          qrBox.style.height = "260px";
          qrBox.innerHTML = `
            <div style="font-size: 36px; line-height: 1;">💬</div>
            <div class="text-xs text-green font-mono font-bold">✓ WhatsApp Already Paired!</div>
            <p class="text-xs text-muted">Active Multi-Device session in <code class="text-dim">.wa-auth/</code>.</p>
          `;
        }
        if (statusBox) statusBox.innerHTML = `<span class="status-dot dot-green"></span><span class="text-green font-mono">Connected</span>`;
        if (actionBtn) {
          actionBtn.textContent = "Unpair & Scan New QR";
          actionBtn.className = "btn text-xs text-amber";
        }
        showToast("WhatsApp device is already paired and connected!", "success");
        refreshWhatsAppStatus();
      } else if (res.qrSvg) {
        if (instructions) instructions.classList.remove("hidden");
        if (qrBox) {
          qrBox.className = "flex items-center justify-center p-4 bg-white rounded-xl mx-auto";
          qrBox.style.width = "260px";
          qrBox.style.height = "260px";
          qrBox.innerHTML = res.qrSvg;
        }
        if (statusBox) statusBox.innerHTML = `<span class="status-dot dot-amber"></span><span>Scan QR with phone</span>`;
        if (actionBtn) {
          actionBtn.textContent = "Reset & Scan New QR";
          actionBtn.className = "btn text-xs text-muted hover:text-white";
        }
        startWhatsAppPolling();
      } else {
        if (instructions) instructions.classList.remove("hidden");
        if (qrBox) qrBox.innerHTML = `<div class="text-xs text-black font-mono">Initializing WhatsApp socket...</div>`;
        startWhatsAppPolling();
      }
    } catch (err) {
      if (qrBox) qrBox.innerHTML = `<div class="text-xs text-red font-mono">Error: ${escapeHtml(err.message)}</div>`;
    }
  }
  window.openWhatsAppModal = openWhatsAppModal;

  async function resetWhatsAppPairing() {
    const qrBox = $("#waQrBox");
    const statusBox = $("#waPairStatus");
    const instructions = $("#waInstructions");
    const actionBtn = $("#waActionBtn");

    if (qrBox) {
      qrBox.className = "flex items-center justify-center p-4 bg-white rounded-xl mx-auto";
      qrBox.style.width = "260px";
      qrBox.style.height = "260px";
      qrBox.innerHTML = `<div class="text-xs text-black font-mono">Resetting auth &amp; requesting fresh QR...</div>`;
    }
    if (instructions) instructions.classList.remove("hidden");
    if (statusBox) statusBox.innerHTML = `<span class="status-dot dot-amber"></span><span>Generating fresh QR...</span>`;
    if (actionBtn) {
      actionBtn.textContent = "Reset & Scan New QR";
      actionBtn.className = "btn text-xs text-muted hover:text-white";
    }

    try {
      const res = await fetchJSON("/api/channels/whatsapp/pair?force=1", { method: "POST" });
      if (res.qrSvg && qrBox) {
        qrBox.innerHTML = res.qrSvg;
        if (statusBox) statusBox.innerHTML = `<span class="status-dot dot-amber"></span><span>Scan QR with phone</span>`;
        startWhatsAppPolling();
      } else {
        startWhatsAppPolling();
      }
    } catch (err) {
      if (qrBox) qrBox.innerHTML = `<div class="text-xs text-red font-mono">Error: ${escapeHtml(err.message)}</div>`;
    }
  }
  window.resetWhatsAppPairing = resetWhatsAppPairing;

  function closeWhatsAppModal() {
    const m = $("#whatsappModal");
    if (m) m.classList.add("hidden");
    if (waPollTimer) {
      clearInterval(waPollTimer);
      waPollTimer = null;
    }
    refreshWhatsAppStatus();
  }
  window.closeWhatsAppModal = closeWhatsAppModal;

  function startWhatsAppPolling() {
    if (waPollTimer) clearInterval(waPollTimer);
    waPollTimer = setInterval(async () => {
      try {
        const data = await fetchJSON("/api/channels/whatsapp/status");
        const qrBox = $("#waQrBox");
        const statusBox = $("#waPairStatus");
        const waBadge = $("#waStatusBadge");
        const instructions = $("#waInstructions");
        const actionBtn = $("#waActionBtn");

        if (data.qrSvg && qrBox && !data.paired) {
          qrBox.className = "flex items-center justify-center p-4 bg-white rounded-xl mx-auto";
          qrBox.style.width = "260px";
          qrBox.style.height = "260px";
          qrBox.innerHTML = data.qrSvg;
          if (instructions) instructions.classList.remove("hidden");
          if (statusBox) statusBox.innerHTML = `<span class="status-dot dot-amber"></span><span>Scan QR with phone</span>`;
        }

        if (data.paired) {
          clearInterval(waPollTimer);
          waPollTimer = null;
          if (instructions) instructions.classList.add("hidden");
          if (qrBox) {
            qrBox.className = "flex flex-col items-center justify-center p-6 bg-card border rounded-xl mx-auto space-y-2 text-center";
            qrBox.style.width = "260px";
            qrBox.style.height = "260px";
            qrBox.innerHTML = `
              <div style="font-size: 36px; line-height: 1;">💬</div>
              <div class="text-xs text-green font-mono font-bold">✓ WhatsApp Connected!</div>
              <p class="text-xs text-muted">Active Multi-Device session in <code class="text-dim">.wa-auth/</code>.</p>
            `;
          }
          if (statusBox) statusBox.innerHTML = `<span class="status-dot dot-green"></span><span class="text-green font-mono">Connected</span>`;
          if (actionBtn) {
            actionBtn.textContent = "Unpair & Scan New QR";
            actionBtn.className = "btn text-xs text-amber";
          }
          if (waBadge) {
            waBadge.textContent = "Paired";
            waBadge.className = "badge badge-green font-mono";
          }
          showToast("WhatsApp device paired successfully!", "success");
          refreshWhatsAppStatus();
          setTimeout(() => closeWhatsAppModal(), 1800);
        }
      } catch {}
    }, 800);
  }

  // Telegram Setup Modal
  function openTelegramModal() {
    const m = $("#telegramModal");
    if (m) m.classList.remove("hidden");
  }
  window.openTelegramModal = openTelegramModal;

  function closeTelegramModal() {
    const m = $("#telegramModal");
    if (m) m.classList.add("hidden");
  }
  window.closeTelegramModal = closeTelegramModal;

  async function submitTelegramSetup(e) {
    e.preventDefault();
    const token = $("#tgBotToken")?.value.trim();
    const ownerRecipient = $("#tgOwnerId")?.value.trim();
    const statusEl = $("#tgVerifyStatus");

    if (!token) return;
    if (statusEl) {
      statusEl.classList.remove("hidden");
      statusEl.textContent = "Verifying bot token with Telegram API...";
      statusEl.className = "text-xs card-subtle p-2 font-mono text-muted";
    }

    try {
      const res = await fetchJSON("/api/channels/telegram/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, ownerRecipient }),
      });

      if (res.ok) {
        if (statusEl) {
          statusEl.textContent = res.message || "Bot verified successfully!";
          statusEl.className = "text-xs card-subtle p-2 font-mono text-green";
        }
        showToast(res.message || "Telegram bot verified & saved!", "success");
        const tgBadge = $("#tgStatusBadge");
        if (tgBadge) tgBadge.textContent = "Active";
        setTimeout(() => closeTelegramModal(), 1500);
      } else {
        if (statusEl) {
          statusEl.textContent = res.error || "Verification failed";
          statusEl.className = "text-xs card-subtle p-2 font-mono text-red";
        }
      }
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = `Error: ${err.message}`;
        statusEl.className = "text-xs card-subtle p-2 font-mono text-red";
      }
    }
  }
  window.submitTelegramSetup = submitTelegramSetup;

  // Integrations Tab (Email Accounts & Extension Controls)
  async function loadEmailAccounts() {
    const container = $("#emailAccountsContainer");
    if (!container) return;

    try {
      const data = await fetchJSON("/api/email/accounts");
      state.emailAccounts = data.accounts || [];
      renderEmailAccounts();
    } catch (err) {
      console.warn("Could not load email accounts:", err);
    }
  }

  function renderEmailAccounts() {
    const container = $("#emailAccountsContainer");
    if (!container) return;

    if (state.emailAccounts.length === 0) {
      container.innerHTML = `
        <div class="card p-4 space-y-2 col-span-2 text-center">
          <div class="text-xs text-muted">No connected email accounts.</div>
          <button class="btn btn-sm btn-primary" onclick="openAddImapModal()">+ Add IMAP Account</button>
        </div>
      `;
      return;
    }

    container.innerHTML = state.emailAccounts.map((acc) => {
      const isGoogle = acc.type === "google";
      return `
        <div class="card p-4 space-y-3">
          <div class="flex justify-between items-center">
            <div class="flex items-center gap-2">
              <span class="text-base">${isGoogle ? "🇬" : "✉️"}</span>
              <span class="font-bold text-white text-xs">${escapeHtml(acc.name || acc.email)}</span>
            </div>
            <span class="badge badge-green font-mono">Connected</span>
          </div>
          <div class="text-xs text-muted font-mono">${escapeHtml(acc.email)} ${acc.host ? `(${escapeHtml(acc.host)}:${acc.port || 993})` : ""}</div>
          <div class="flex justify-between items-center pt-2 border-t text-xs">
            <button class="btn btn-sm" onclick="testEmailAccount('${escapeHtml(acc.id)}')">Test Connection</button>
            <button class="btn btn-sm btn-danger" onclick="deleteEmailAccount('${escapeHtml(acc.id)}')">Disconnect</button>
          </div>
        </div>
      `;
    }).join("");
  }

  async function testEmailAccount(id) {
    showToast(`Testing email account connection...`, "info");
    try {
      const res = await fetchJSON(`/api/email/accounts/${encodeURIComponent(id)}/test`, {
        method: "POST",
      });
      showToast(res.message || "Email connection verified successfully!", "success");
    } catch (err) {
      showToast(`Connection test failed: ${err.message}`, "error");
    }
  }
  window.testEmailAccount = testEmailAccount;

  async function testFirstEmailAccount() {
    if (state.emailAccounts.length > 0 && state.emailAccounts[0]) {
      await testEmailAccount(state.emailAccounts[0].id);
    } else {
      switchTab("integrations");
      showToast("Please add an email account first.", "info");
    }
  }
  window.testFirstEmailAccount = testFirstEmailAccount;

  async function deleteEmailAccount(id) {
    if (!confirm("Are you sure you want to remove this email account?")) return;
    try {
      await fetchJSON(`/api/email/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
      showToast("Email account removed.", "success");
      await loadEmailAccounts();
    } catch (err) {
      showToast(`Failed to delete account: ${err.message}`, "error");
    }
  }
  window.deleteEmailAccount = deleteEmailAccount;

  // IMAP Modal
  function openAddImapModal() {
    const m = $("#imapModal");
    if (m) m.classList.remove("hidden");
  }
  window.openAddImapModal = openAddImapModal;

  function closeAddImapModal() {
    const m = $("#imapModal");
    if (m) m.classList.add("hidden");
  }
  window.closeAddImapModal = closeAddImapModal;

  async function submitAddImap(e) {
    e.preventDefault();
    const email = $("#imapEmail")?.value.trim();
    const host = $("#imapHost")?.value.trim();
    const port = parseInt($("#imapPort")?.value.trim() || "993", 10);
    const name = $("#imapName")?.value.trim() || email;

    if (!email || !host) return;

    try {
      await fetchJSON("/api/email/accounts/imap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, host, port, name }),
      });
      showToast("IMAP account added successfully!", "success");
      closeAddImapModal();
      await loadEmailAccounts();
    } catch (err) {
      showToast(`Failed to add IMAP account: ${err.message}`, "error");
    }
  }
  window.submitAddImap = submitAddImap;

  // Scheduler Tab
  function renderScheduler() {
    const tbody = $("#schedulerJobsTableBody");
    if (!tbody) return;

    const jobs = state.overview?.jobs || [];
    if (jobs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted p-4">No scheduled jobs registered.</td></tr>`;
      return;
    }

    tbody.innerHTML = jobs.map((job) => {
      const mode = job.mode || "auto";
      const modeBadge = mode === "agent"
        ? `<span class="badge badge-purple font-mono">🤖 Agent</span>`
        : mode === "reminder"
        ? `<span class="badge badge-amber font-mono">🔔 Reminder</span>`
        : `<span class="badge badge-blue font-mono">⚡ Auto</span>`;

      const nextRunStr = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "Scheduling...";

      return `
        <tr>
          <td>
            <div class="font-bold text-white">${escapeHtml(job.name || job.message)}</div>
            <div class="text-xs text-dim font-mono">${escapeHtml(job.id)}</div>
          </td>
          <td><span class="font-mono text-blue">${escapeHtml(job.cronExpr)}</span></td>
          <td>
            <select class="select-box" style="padding:4px 8px; width:auto;" onchange="toggleJobMode('${escapeHtml(job.id)}', this.value)">
              <option value="auto" ${mode === "auto" ? "selected" : ""}>Auto</option>
              <option value="agent" ${mode === "agent" ? "selected" : ""}>🤖 Agent</option>
              <option value="reminder" ${mode === "reminder" ? "selected" : ""}>🔔 Reminder</option>
            </select>
          </td>
          <td class="font-mono text-muted text-xs">${nextRunStr}</td>
          <td class="text-right">
            <button class="btn btn-sm" onclick="runJob('${escapeHtml(job.id)}')">Run Test</button>
            <button class="btn btn-sm btn-danger" onclick="cancelJob('${escapeHtml(job.id)}')">Cancel</button>
          </td>
        </tr>
      `;
    }).join("");
  }

  async function runJob(jobId) {
    showToast("Triggering scheduled task now...", "info");
    try {
      const res = await fetchJSON(`/api/jobs/${encodeURIComponent(jobId)}/run`, {
        method: "POST",
      });
      showToast(res.message || "Task triggered! Running in background.", "success");
      await loadOverview();
    } catch (err) {
      showToast(`Failed to trigger job: ${err.message}`, "error");
    }
  }
  window.runJob = runJob;

  async function submitNewJob(e) {
    e.preventDefault();
    const when = $("#jobWhen")?.value.trim();
    const mode = $("#jobMode")?.value;
    const name = $("#jobName")?.value.trim();
    const message = $("#jobMessage")?.value.trim();

    if (!when || !message) return;

    try {
      await fetchJSON("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ when, mode, name, message }),
      });
      showToast("Task scheduled successfully!", "success");
      $("#scheduleJobForm")?.reset();
      await loadOverview();
    } catch (err) {
      showToast(`Failed to schedule task: ${err.message}`, "error");
    }
  }
  window.submitNewJob = submitNewJob;

  async function toggleJobMode(jobId, newMode) {
    try {
      await fetchJSON(`/api/jobs/${encodeURIComponent(jobId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: newMode === "auto" ? null : newMode }),
      });
      showToast("Job mode updated", "success");
      await loadOverview();
    } catch (err) {
      showToast(`Failed to update mode: ${err.message}`, "error");
    }
  }
  window.toggleJobMode = toggleJobMode;

  async function cancelJob(jobId) {
    if (!confirm("Are you sure you want to cancel this scheduled task?")) return;
    try {
      await fetchJSON(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      showToast("Task cancelled", "success");
      await loadOverview();
    } catch (err) {
      showToast(`Failed to cancel task: ${err.message}`, "error");
    }
  }
  window.cancelJob = cancelJob;

  // Configuration Tab (Safe JSON5 Editor)
  async function loadConfigRaw() {
    const editor = $("#cfgEditor");
    const badge = $("#cfgStatusBadge");
    if (!editor) return;

    try {
      const data = await fetchJSON("/api/config/raw");
      state.rawConfig = data.raw || "";
      editor.value = state.rawConfig;
      if (badge) {
        badge.textContent = "✓ JSON5 Valid";
        badge.className = "badge badge-green font-mono";
      }
    } catch (err) {
      showToast(`Failed to load config: ${err.message}`, "error");
    }
  }
  window.loadConfigRaw = loadConfigRaw;

  async function saveConfigRaw() {
    const editor = $("#cfgEditor");
    if (!editor) return;
    const raw = editor.value;

    try {
      await fetchJSON("/api/config/raw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw }),
      });
      showToast("Configuration saved successfully!", "success");
      await loadOverview();
    } catch (err) {
      showToast(`Failed to save configuration: ${err.message}`, "error");
    }
  }
  window.saveConfigRaw = saveConfigRaw;

  // Shortcuts
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      if (state.activeTab === "config") {
        e.preventDefault();
        saveConfigRaw();
      }
    }
  });

  // Diagnostics Quick Actions
  async function runEmailReflex() {
    showToast("Triggering background reflex email check...", "info");
    try {
      await fetchJSON("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Run reflex check on unread emails now" }),
      });
      showToast("Reflex check triggered. Reviewing in Activity.", "success");
      setTimeout(() => loadOverview(), 1500);
    } catch (err) {
      showToast(`Reflex trigger failed: ${err.message}`, "error");
    }
  }
  window.runEmailReflex = runEmailReflex;

  function triggerWhatsAppPair() {
    showToast("Scan QR code in terminal to pair WhatsApp device.", "info");
  }
  window.triggerWhatsAppPair = triggerWhatsAppPair;

  // Refresh Button
  const refreshBtn = $("#refreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.textContent = "↻ Syncing...";
      await Promise.all([loadOverview(), loadSessions(), loadEmailAccounts()]);
      refreshBtn.textContent = "↻ Synced";
      setTimeout(() => {
        refreshBtn.textContent = "↻ Refresh";
      }, 1200);
    });
  }

  // Periodic Polling (5s interval, paused when document is hidden)
  function initPolling() {
    setInterval(() => {
      if (document.hidden) return;
      loadOverview();
      if (state.activeTab === "sessions") {
        loadSessions();
      }
    }, 5000);
  }

  // Initialization
  async function init() {
    initRouting();

    // Setup chat input keyboard listeners & auto-resize
    const chatInput = $("#chatInput");
    if (chatInput) {
      chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submitChatMessage();
        }
      });
      chatInput.addEventListener("input", () => {
        autoResizeTextarea(chatInput);
      });
    }

    await Promise.all([loadOverview(), loadSessions(), loadEmailAccounts()]);
    initPolling();
  }

  window.addEventListener("DOMContentLoaded", init);
})();
