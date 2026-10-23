const VERSION = "2.1";
const state = {
  overview: null,
  selectedSessionKey: null,
  selectedSession: null,
  configRaw: "",
  activeTab: "overview",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

async function fetchJSON(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || `Request failed: ${response.status}`);
  }
  return payload;
}

function fmtNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function fmtMoney(value) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(Number(value || 0));
}

function fmtAgo(ts) {
  if (!ts) return "never";
  const delta = Date.now() - Number(ts);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setStatus(text, tone = "slate") {
  const node = $("#configStatus");
  if (!node) return;
  node.className = `text-xs font-bold uppercase tracking-widest ${
    tone === "green" ? "text-teal-600" : tone === "amber" ? "text-amber-600" : "text-ink-400"
  }`;
  node.textContent = text;
  if (text) setTimeout(() => { if (node.textContent === text) node.textContent = ""; }, 5000);
}

function pushLog(text, tone = "system") {
  const log = $("#chatLog");
  if (!log) return;
  const entry = document.createElement("div");
  const colorClass =
    tone === "user"
      ? "bg-teal-50 border-teal-100 text-ink-900 ml-8"
      : tone === "assistant"
      ? "bg-white border-ink-100 text-ink-900 mr-8"
      : "bg-amber-50 border-amber-100 text-ink-800 italic text-center text-xs";

  entry.className = `rounded-2xl border px-5 py-3 text-sm leading-relaxed shadow-sm ${colorClass}`;
  entry.textContent = text;
  log.prepend(entry);
}

async function loadOverview() {
  state.overview = await fetchJSON("/api/overview");
  renderDaemonStatus();
  renderOverviewStats();
  renderCostsOverview();
  renderSessions();
  renderSkills();
  renderJobs();
  
  if (!state.selectedSessionKey && state.overview.sessions?.active?.[0]) {
    await loadSession(state.overview.sessions.active[0].key);
  }
}

async function loadConfig() {
  const config = await fetchJSON("/api/config/raw");
  state.configRaw = config.raw;
  const editor = $("#configEditor");
  if (editor) editor.value = config.raw;
}

async function loadSession(sessionKey) {
  state.selectedSessionKey = sessionKey;
  renderSessions();
  const session = await fetchJSON(`/api/sessions/${encodeURIComponent(sessionKey)}`);
  state.selectedSession = session;
  renderSessionDetail();
}

function renderDaemonStatus() {
  const overview = state.overview;
  if (!overview) return;

  const daemon = overview.daemon;
  const badge = $("#daemonBadge");
  if (badge) {
    badge.textContent = daemon.running ? "Daemon online" : "Daemon offline";
    badge.className = `inline-flex rounded-full px-3 py-0.5 text-xs font-bold ring-1 uppercase tracking-wider ${
      daemon.running ? "bg-teal-50 text-teal-600 ring-teal-100" : "bg-amber-50 text-amber-600 ring-amber-100"
    }`;
  }

  const meta = $("#statusMeta");
  if (meta && daemon) {
    meta.innerHTML = `
      <div class="flex items-center justify-between p-3 rounded-xl bg-white/50 border border-white">
        <span class="text-ink-400 font-medium">Socket</span>
        <span class="font-bold ${daemon.socketExists ? "text-teal-600" : "text-amber-600"}">${daemon.socketExists ? "Connected" : "Disconnected"}</span>
      </div>
      <div class="flex items-center justify-between p-3 rounded-xl bg-white/50 border border-white">
        <span class="text-ink-400 font-medium">Active Sessions</span>
        <span class="font-bold text-ink-900">${overview.sessions?.total || 0}</span>
      </div>
      <div class="flex items-center justify-between p-3 rounded-xl bg-white/50 border border-white">
        <span class="text-ink-400 font-medium">Pending Jobs</span>
        <span class="font-bold text-ink-900">${overview.jobs?.length || 0}</span>
      </div>
    `;
  }
  
  const hint = $("#overviewHint");
  if (hint) hint.textContent = daemon.pid ? `PID: ${daemon.pid} · Path: ${daemon.stateDir}` : "No active daemon process found";
}

function renderOverviewStats() {
  const overview = state.overview;
  if (!overview) return;

  const statsContainer = $("#stats");
  if (!statsContainer) return;

  const readySkills = overview.skills?.filter((s) => s.eligible).length || 0;
  const stats = [
    { label: "Total Sessions", value: fmtNumber(overview.sessions?.total), color: "teal" },
    { label: "Active Jobs", value: fmtNumber(overview.jobs?.length), color: "amber" },
    { label: "Ready Skills", value: fmtNumber(readySkills), color: "teal" },
    { label: "Total Cost", value: fmtMoney(overview.sessions?.usage?.costTotal), color: "ink" },
  ];

  statsContainer.innerHTML = stats.map(s => `
    <div class="rounded-3xl border border-white/70 bg-white/70 p-6 shadow-soft backdrop-blur-xl">
      <div class="text-xs font-bold uppercase tracking-widest text-ink-400">${s.label}</div>
      <div class="mt-2 text-3xl font-black text-ink-900">${s.value}</div>
    </div>
  `).join("");
}

function renderCostsOverview() {
  const overview = state.overview;
  const container = $("#costsOverview");
  if (!container || !overview) return;

  const sessions = overview.sessions?.active?.slice(0, 4) || [];
  if (sessions.length === 0) {
    container.innerHTML = `<p class="text-sm text-ink-400 italic">No usage data yet.</p>`;
    return;
  }

  container.innerHTML = sessions.map(s => `
    <div class="flex items-center justify-between p-4 rounded-2xl bg-white/50 border border-white group transition-all hover:bg-white">
      <div>
        <div class="text-sm font-bold text-ink-900 group-hover:text-teal-600 transition-colors">${s.key}</div>
        <div class="text-[10px] font-bold text-ink-400 uppercase tracking-widest mt-0.5">${s.usage?.costSource || "unknown"}</div>
      </div>
      <div class="text-right">
        <div class="text-sm font-black text-ink-900">${fmtMoney(s.usage?.costTotal)}</div>
        <div class="text-[10px] font-bold text-ink-400 uppercase tracking-widest mt-0.5">${fmtNumber(s.usage?.totalTokens)} tokens</div>
      </div>
    </div>
  `).join("");
}

function renderSessions() {
  const overview = state.overview;
  const container = $("#sessions");
  if (!container || !overview) return;

  const active = overview.sessions?.active || [];
  if (active.length === 0) {
    container.innerHTML = `<div class="p-8 text-center text-ink-400 italic">No sessions found.</div>`;
    return;
  }

  container.innerHTML = active.map(s => `
    <button type="button" data-session-key="${s.key}" class="w-full p-6 text-left border-b border-ink-100 transition-all hover:bg-white group ${state.selectedSessionKey === s.key ? "bg-white/80" : ""}">
      <div class="flex justify-between items-start mb-1">
        <span class="text-sm font-bold text-ink-900 group-hover:text-teal-600 transition-colors truncate mr-4">${s.key}</span>
        <span class="text-[10px] font-bold text-ink-400 whitespace-nowrap">${fmtAgo(s.lastActive)}</span>
      </div>
      <div class="text-xs text-ink-500 line-clamp-2 leading-relaxed mb-3">${s.preview || "No preview available"}</div>
      <div class="flex items-center gap-3">
        <span class="inline-flex items-center px-2 py-0.5 rounded bg-ink-100 text-[10px] font-bold text-ink-600 uppercase tracking-wider">${s.channel}</span>
        <span class="text-[10px] font-bold text-ink-400 uppercase tracking-wider">${fmtNumber(s.messageCount)} msgs</span>
        <span class="ml-auto text-xs font-black text-ink-900">${fmtMoney(s.usage?.costTotal)}</span>
      </div>
    </button>
  `).join("");

  $$("[data-session-key]").forEach(btn => {
    btn.onclick = () => loadSession(btn.getAttribute("data-session-key"));
  });
}

function renderSessionDetail() {
  const panel = $("#sessionDetail");
  const session = state.selectedSession;
  const title = $("#sessionDetailTitle");
  const meta = $("#selectedSessionMeta");
  const focusBtn = $("#focusSessionButton");

  if (!panel || !session) return;

  if (title) title.textContent = session.key;
  if (meta) meta.textContent = `${session.channel} · ${fmtNumber(session.messageCount)} messages · ${fmtMoney(session.usage?.costTotal)} · ${fmtNumber(session.usage?.totalTokens)} tokens`;
  if (focusBtn) focusBtn.disabled = false;

  panel.innerHTML = (session.messages || []).map(msg => {
    const isAssistant = msg.role === "assistant";
    const isSystem = msg.role === "system";
    
    let content = "";
    if (typeof msg.content === "string") {
      content = escapeHtml(msg.content);
    } else {
      content = `<pre class="text-xs bg-ink-900 text-teal-100 p-4 rounded-xl overflow-x-auto">${escapeHtml(JSON.stringify(msg.content, null, 2))}</pre>`;
    }

    const usage = msg.usage ? `
      <div class="flex gap-3 mt-4 pt-3 border-t border-ink-100">
        <span class="text-[10px] font-bold text-ink-400 uppercase tracking-wider">${fmtNumber(msg.usage.totalTokens)} tokens</span>
        <span class="text-[10px] font-bold text-ink-400 uppercase tracking-wider">${fmtMoney(msg.usage.cost?.total)}</span>
      </div>
    ` : "";

    return `
      <div class="flex flex-col ${isAssistant ? "items-start" : isSystem ? "items-center" : "items-end"}">
        <div class="max-w-[85%] ${isSystem ? "w-full" : ""}">
          <div class="flex items-center gap-2 mb-2 px-1 ${isAssistant ? "justify-start" : isSystem ? "justify-center" : "justify-end"}">
            <span class="text-[10px] font-black uppercase tracking-widest text-ink-400">${msg.role}</span>
            <span class="text-[10px] font-bold text-ink-300">${new Date(msg.timestamp).toLocaleTimeString()}</span>
          </div>
          <div class="rounded-3xl p-6 shadow-sm border ${
            isAssistant ? "bg-white border-ink-100 text-ink-900 rounded-tl-none" :
            isSystem ? "bg-amber-50/50 border-amber-100 text-ink-700 text-sm italic" :
            "bg-teal-600 border-teal-500 text-white rounded-tr-none"
          }">
            <div class="whitespace-pre-wrap leading-relaxed text-sm">${content}</div>
            ${usage}
          </div>
        </div>
      </div>
    `;
  }).join("");
  
  panel.scrollTop = panel.scrollHeight;
}

function renderSkills() {
  const overview = state.overview;
  if (!overview) return;

  const summaryContainer = $("#skillsSummary");
  const skillsGrid = $("#skills");
  if (!summaryContainer || !skillsGrid) return;

  const skills = overview.skills || [];
  const ready = skills.filter(s => s.eligible);
  const needsSetup = skills.filter(s => !s.eligible);

  summaryContainer.innerHTML = `
    <div class="rounded-3xl border border-white/70 bg-white/70 p-6 shadow-soft backdrop-blur-xl">
      <div class="text-xs font-bold uppercase tracking-widest text-teal-600">Ready to Use</div>
      <div class="mt-2 text-3xl font-black text-ink-900">${ready.length}</div>
    </div>
    <div class="rounded-3xl border border-white/70 bg-white/70 p-6 shadow-soft backdrop-blur-xl">
      <div class="text-xs font-bold uppercase tracking-widest text-amber-600">Needs Setup</div>
      <div class="mt-2 text-3xl font-black text-ink-900">${needsSetup.length}</div>
    </div>
  `;

  skillsGrid.innerHTML = skills.map(skill => `
    <div class="flex flex-col rounded-3xl border border-white/70 bg-white/70 p-6 shadow-soft backdrop-blur-xl transition-all hover:translate-y-[-4px]">
      <div class="flex items-start justify-between mb-4">
        <span class="text-3xl">${skill.emoji || "🛠️"}</span>
        <span class="inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider ring-1 ${
          skill.eligible ? "bg-teal-50 text-teal-600 ring-teal-100" : "bg-amber-50 text-amber-600 ring-amber-100"
        }">${skill.eligible ? "Ready" : "Setup"}</span>
      </div>
      <h3 class="text-lg font-black text-ink-900 mb-2">${skill.name}</h3>
      <p class="text-xs text-ink-500 leading-relaxed flex-1">${skill.description}</p>
      
      ${!skill.eligible ? `
        <div class="mt-6 pt-4 border-t border-ink-100">
          <button data-install-skill="${skill.name}" class="w-full rounded-xl bg-ink-900 py-2.5 text-xs font-bold text-white transition hover:bg-ink-800">Install Skill</button>
        </div>
      ` : ""}
    </div>
  `).join("");

  $$("[data-install-skill]").forEach(btn => {
    btn.onclick = async () => {
      const name = btn.getAttribute("data-install-skill");
      try {
        btn.disabled = true;
        btn.textContent = "Installing...";
        await fetchJSON("/api/skills/install", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
        await loadOverview();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
        btn.textContent = "Install Skill";
      }
    };
  });
}

function renderJobs() {
  const overview = state.overview;
  const container = $("#jobs");
  if (!container || !overview) return;

  const jobs = overview.jobs || [];
  if (jobs.length === 0) {
    container.innerHTML = `<div class="col-span-full py-12 text-center text-ink-300 font-medium bg-white/30 rounded-3xl border-2 border-dashed border-white">No scheduled jobs at the moment.</div>`;
    return;
  }

  container.innerHTML = jobs.map(job => `
    <div class="rounded-3xl border border-white/70 bg-white/70 p-6 shadow-soft backdrop-blur-xl group">
      <div class="flex justify-between items-start mb-4">
        <div>
          <h4 class="text-lg font-black text-ink-900">${job.name}</h4>
          <p class="text-sm font-medium text-teal-600 mt-0.5">${job.cronExpr}</p>
        </div>
        <button data-cancel-job="${job.id}" class="text-xs font-bold text-amber-600 uppercase tracking-widest hover:text-amber-700 transition-colors">Cancel</button>
      </div>
      <div class="p-4 rounded-2xl bg-ink-900 text-teal-50 text-sm leading-relaxed mb-4">
        ${job.message}
      </div>
      <div class="text-[10px] font-bold text-ink-400 uppercase tracking-widest">
        Next run: ${job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "Scheduling..."}
      </div>
    </div>
  `).join("");

  $$("[data-cancel-job]").forEach(btn => {
    btn.onclick = async () => {
      if (confirm("Cancel this job?")) {
        await fetchJSON(`/api/jobs/${encodeURIComponent(btn.getAttribute("data-cancel-job"))}`, { method: "DELETE" });
        await loadOverview();
      }
    };
  });
}

async function submitChat(e) {
  e.preventDefault();
  const input = $("#chatInput");
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  pushLog(text, "user");
  input.value = "";
  input.style.height = "auto";

  // Show thinking indicator
  const log = $("#chatLog");
  const pendingDiv = document.createElement("div");
  pendingDiv.id = "chatPendingIndicator";
  pendingDiv.className =
    "rounded-2xl border border-ink-100 bg-white/70 px-5 py-3 text-xs italic text-ink-500 shadow-sm animate-pulse mr-8 flex items-center gap-2";
  pendingDiv.innerHTML = `<span class="inline-block w-2 h-2 rounded-full bg-teal-500 animate-ping"></span> MinClaw is thinking and executing tools...`;
  if (log) log.prepend(pendingDiv);

  try {
    const response = await fetchJSON("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, sessionKey: "web-dashboard" }),
    });

    if (pendingDiv && pendingDiv.parentNode) {
      pendingDiv.remove();
    }

    for (const reply of response.replies || []) {
      const isSystem = reply.includes("Thinking") || reply.includes("Working") || reply.includes("Searching");
      pushLog(reply, isSystem ? "system" : "assistant");
    }
    await loadOverview();
  } catch (err) {
    if (pendingDiv && pendingDiv.parentNode) {
      pendingDiv.remove();
    }
    pushLog(err.message, "system");
  }
}

async function submitJob(e) {
  e.preventDefault();
  const whenEl = $("#jobWhen");
  const msgEl = $("#jobMessage");
  if (!whenEl || !msgEl) return;

  const when = whenEl.value.trim();
  const message = msgEl.value.trim();
  if (!when || !message) return;

  try {
    await fetchJSON("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `/schedule ${when} ${message}`, sessionKey: "web-dashboard" }),
    });
    whenEl.value = "";
    msgEl.value = "";
    await loadOverview();
    switchTab("jobs");
  } catch (err) {
    alert(err.message);
  }
}

async function saveConfig() {
  const editor = $("#configEditor");
  if (!editor) return;
  const raw = editor.value;
  try {
    setStatus("Saving...", "amber");
    await fetchJSON("/api/config/raw", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    state.configRaw = raw;
    setStatus("Config saved successfully", "green");
  } catch (err) {
    setStatus(err.message, "amber");
  }
}

// --- Accounts Management ---
async function loadEmailAccounts() {
  const listNode = $("#accountsList");
  if (!listNode) return;
  try {
    const res = await fetchJSON("/api/email/accounts");
    const accounts = res.accounts || [];
    if (accounts.length === 0) {
      listNode.innerHTML = `
        <div class="rounded-2xl border border-dashed border-ink-200 p-8 text-center bg-white/40">
          <p class="text-sm font-bold text-ink-700">No email accounts connected yet</p>
          <p class="text-xs text-ink-400 mt-1">Connect your Google account or university IMAP on the right.</p>
        </div>
      `;
      return;
    }

    listNode.innerHTML = accounts
      .map((acc) => {
        const isGoogle = acc.type === "google";
        const iconSvg = isGoogle
          ? `<div class="w-10 h-10 rounded-2xl bg-white flex items-center justify-center shadow-sm border border-ink-100 flex-shrink-0">
               <svg class="w-5 h-5" viewBox="0 0 24 24">
                 <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                 <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                 <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                 <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
               </svg>
             </div>`
          : `<div class="w-10 h-10 rounded-2xl bg-teal-50 flex items-center justify-center shadow-sm border border-teal-100 text-teal-600 text-lg flex-shrink-0">
               🏛️
             </div>`;

        const statusBadge =
          acc.status === "connected"
            ? `<span class="inline-flex items-center gap-1 text-[11px] font-bold text-teal-600 bg-teal-50 px-2 py-0.5 rounded-full ring-1 ring-teal-200">
                 <span class="w-1.5 h-1.5 rounded-full bg-teal-500"></span> Connected
               </span>`
            : `<span class="inline-flex items-center gap-1 text-[11px] font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full ring-1 ring-rose-200">
                 <span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span> Error
               </span>`;

        return `
          <div class="flex items-center justify-between p-4 rounded-2xl bg-white/80 border border-ink-100 shadow-sm transition hover:shadow-md">
            <div class="flex items-center gap-3.5 min-w-0">
              ${iconSvg}
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <h4 class="text-sm font-bold text-ink-900 truncate">${escapeHtml(acc.displayName || acc.email)}</h4>
                  ${statusBadge}
                </div>
                <p class="text-xs text-ink-500 truncate">${escapeHtml(acc.email)}</p>
                ${acc.imapHost ? `<p class="text-[10px] text-ink-400 font-mono mt-0.5">${escapeHtml(acc.imapHost)}</p>` : ""}
              </div>
            </div>
            <button data-disconnect-id="${escapeHtml(acc.id)}" class="disconnect-btn text-xs font-bold text-rose-600 hover:text-rose-700 hover:bg-rose-50 px-3 py-1.5 rounded-xl transition">
              Disconnect
            </button>
          </div>
        `;
      })
      .join("");

    $$(".disconnect-btn").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.getAttribute("data-disconnect-id");
        if (!confirm(`Are you sure you want to disconnect this account?`)) return;
        try {
          await fetchJSON(`/api/email/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
          await loadEmailAccounts();
        } catch (err) {
          alert(`Failed to disconnect: ${err.message}`);
        }
      };
    });
  } catch (err) {
    listNode.innerHTML = `<div class="p-4 text-xs text-rose-600">Failed to load accounts: ${err.message}</div>`;
  }
}

function showAccountsAlert(message, type = "success") {
  const alert = $("#accountsAlert");
  if (!alert) return;
  alert.className = `rounded-2xl p-4 text-sm font-bold shadow-sm transition-all ${
    type === "success"
      ? "bg-teal-50 text-teal-800 border border-teal-200"
      : "bg-rose-50 text-rose-800 border border-rose-200"
  }`;
  alert.textContent = message;
  alert.classList.remove("hidden");
  setTimeout(() => alert.classList.add("hidden"), 8000);
}

function switchTab(tabId) {
  console.log("Switching to tab:", tabId);
  state.activeTab = tabId;
  
  $$(".tab-content").forEach(el => el.classList.remove("active"));
  $$(".tab-btn").forEach(el => el.classList.remove("active"));
  
  const content = $(`#tab-${tabId}`);
  const btn = $(`[data-tab="${tabId}"]`);
  
  if (content) content.classList.add("active");
  if (btn) btn.classList.add("active");
  
  if (tabId === "config") loadConfig();
  if (tabId === "accounts") {
    loadEmailAccounts();
  }
}

function wireEvents() {
  console.log("Wiring events...");
  $$("[data-tab]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      switchTab(btn.getAttribute("data-tab"));
    });
  });

  const chatForm = $("#chatForm");
  if (chatForm) chatForm.onsubmit = submitChat;

  const jobForm = $("#jobForm");
  if (jobForm) jobForm.onsubmit = submitJob;

  const refreshBtn = $("#refreshButton");
  if (refreshBtn) refreshBtn.onclick = () => loadOverview();

  const saveConfigBtn = $("#saveConfigButton");
  if (saveConfigBtn) saveConfigBtn.onclick = saveConfig;
  
  const focusBtn = $("#focusSessionButton");
  if (focusBtn) {
    focusBtn.onclick = () => {
      if (state.selectedSessionKey) {
        switchTab("overview");
        pushLog(`Focusing conversation: ${state.selectedSessionKey}`, "system");
      }
    };
  }

  const chatInput = $("#chatInput");
  if (chatInput) {
    chatInput.oninput = () => {
      chatInput.style.height = "auto";
      chatInput.style.height = (chatInput.scrollHeight) + "px";
    };
  }

  // --- Accounts Event Wiring ---
  const refreshAccountsBtn = $("#refreshAccountsButton");
  if (refreshAccountsBtn) refreshAccountsBtn.onclick = () => loadEmailAccounts();

  const imapForm = $("#imapAccountForm");
  if (imapForm) {
    imapForm.onsubmit = async (e) => {
      e.preventDefault();
      const email = $("#imapEmail")?.value.trim();
      const displayName = $("#imapDisplayName")?.value.trim() || email;
      const host = $("#imapHost")?.value.trim();
      const port = Number($("#imapPort")?.value) || 993;
      const user = $("#imapUser")?.value.trim() || email;
      const pass = $("#imapPass")?.value;
      const tls = $("#imapTls")?.checked !== false;

      const smtpHost = $("#smtpHost")?.value.trim();
      const smtpPort = Number($("#smtpPort")?.value) || 465;

      const statusNode = $("#imapFormStatus");
      const submitBtn = $("#imapSubmitButton");

      if (!email || !host || !pass) return;

      try {
        if (submitBtn) submitBtn.disabled = true;
        if (statusNode) statusNode.textContent = "Connecting...";

        await fetchJSON("/api/email/accounts/imap", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email,
            displayName,
            host,
            port,
            tls,
            user,
            pass,
            smtpHost: smtpHost || undefined,
            smtpPort: smtpHost ? smtpPort : undefined,
          }),
        });

        if (statusNode) statusNode.textContent = "";
        imapForm.reset();
        showAccountsAlert(`University account ${email} connected successfully!`, "success");
        await loadEmailAccounts();
      } catch (err) {
        if (statusNode) statusNode.textContent = "Error: " + err.message;
        showAccountsAlert(`Failed to connect IMAP account: ${err.message}`, "error");
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    };
  }
}

async function init() {
  console.log(`MinClaw Dashboard v${VERSION} Initializing...`);
  wireEvents();
  await loadOverview();
  await loadConfig();

  // Handle URL hash or query params from OAuth redirects
  const urlParams = new URLSearchParams(window.location.search);
  const hash = window.location.hash;

  if (hash.includes("accounts") || urlParams.has("success") || urlParams.has("error")) {
    switchTab("accounts");
    if (urlParams.get("success") === "google_connected") {
      const email = urlParams.get("email") || "Google Account";
      showAccountsAlert(`Successfully connected ${email}!`, "success");
    } else if (urlParams.has("error")) {
      showAccountsAlert(`Connection error: ${urlParams.get("error")}`, "error");
    }
    window.history.replaceState({}, document.title, window.location.pathname + "#accounts");
  }
}

init().catch(err => {
  console.error("Dashboard initialization failed", err);
  pushLog("Failed to initialize dashboard: " + err.message, "system");
});
