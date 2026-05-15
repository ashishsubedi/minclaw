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

  try {
    const response = await fetchJSON("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, sessionKey: "web-dashboard" }),
    });

    for (const reply of response.replies || []) {
      const isSystem = reply.includes("Thinking") || reply.includes("Working") || reply.includes("Searching");
      pushLog(reply, isSystem ? "system" : "assistant");
    }
    await loadOverview();
  } catch (err) {
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
}

async function init() {
  console.log(`MinClaw Dashboard v${VERSION} Initializing...`);
  wireEvents();
  await loadOverview();
  await loadConfig();
}

init().catch(err => {
  console.error("Dashboard initialization failed", err);
  pushLog("Failed to initialize dashboard: " + err.message, "system");
});
