<p align="center">
  <img src="public/minclaw.svg" width="200" alt="MinClaw logo" />
</p>

# MinClaw

**Your own personal AI assistant. AI that rewrites itself.**

MinClaw is a self-improving AI agent that runs as a background daemon on your machine. Chat with it from your terminal, WhatsApp, Telegram, or Slack — and it can edit its own source code to add features, fix bugs, and grow.

<p align="center">
  <img src="public/minclaw-in-whatsapp.png" width="150" alt="MinClaw on WhatsApp" /><br/>
Nakedclaw in Whatsapp
</p>

## Why MinClaw?

[OpenClaw](https://github.com/openclaw/openclaw) is great, but it's wearing a lot of clothes:

- A **macOS app** (204 Swift files, code signing, notarization, DMG packaging)
- An **iOS app** (28 Swift files, Xcode provisioning)
- An **Android app** (63 Kotlin files, Gradle build)
- A **web dashboard** (113 files, Lit components, Vite, Playwright)
- **127 npm dependencies** including sharp, pdfjs, playwright, AWS Bedrock SDK
- **617 documentation files** + a full Chinese translation pipeline
- **7 CI/CD workflows**, Docker images, 50+ release scripts
- **451,926 lines of code** across 2,581 files

MinClaw strips all of that away. No Mac app. No web server. No mobile apps. No 32 channel plugins. No Docker. No CI. Just a daemon, a CLI, and two messaging channels. ~3,000 lines of TypeScript.

All the good functionality. None of the clothes. Truly naked.

## Features

- **Memory** — chat history is saved in `memory/chats/*.md` and indexed in `memory/temporary-memory.md`; persistent user/project facts live in `brain/permanent-memory.md` and are loaded every session
- **Heartbeat** — configurable cron that triggers the agent periodically
- **Scheduler** — natural language scheduling ("remind me at 10", "every day at 9am")
- **Multiple terminals** — open as many `minclaw` sessions as you want
- **Config hot-reload** — edit `minclaw.json5` and heartbeat/scheduler update automatically
- **Skills** — MinClaw reaches its long, naked claw into the [openclaw](https://github.com/openclaw/openclaw) skill catalog and shamelessly steals every single skill. 100% compatible with all openclaw skills — turns out you don't need clothes to be talented

<p align="center">
  <img src="public/sc-Terminal.gif" width="700" alt="MinClaw terminal chat" /><br/>
  Access it via the terminal
</p>

## Quick start

```bash
bun install
bun link

minclaw setup     # authenticate (Anthropic or OpenAI)
minclaw start     # start the daemon
minclaw           # chat
```

## Auth

MinClaw supports multiple authentication methods:

**Anthropic:**
- **Setup token** (recommended) — run `claude setup-token` in another terminal and paste the result
- **API key** — paste your `sk-ant-api03-...` key directly

**OpenAI:**
- **API key** — paste your `sk-...` key
- **Codex** (ChatGPT subscription) — browser-based OAuth login, no API key needed

**Ollama:**
- **Local models** — use the OpenAI-compatible endpoint (default `http://localhost:11434/v1`)
- **Base URL** — set `model.baseUrl` in `minclaw.json5` (optional if using default)
- **Token** — optional; save with `minclaw setup` or set `OLLAMA_API_KEY`
- **Select model** — `minclaw models set ollama/<model>` (free-form)

## CLI

```
minclaw              chat with the agent
minclaw setup        authenticate (Anthropic or OpenAI)
minclaw models       interactive model/provider picker
minclaw models set <provider>/<model>  set model directly
minclaw start        start the background daemon
minclaw stop         stop the daemon
minclaw restart      restart the daemon
minclaw status       show daemon status
minclaw logs         tail daemon logs
minclaw sessions     interactive session browser (live TUI)

minclaw skills       list skills with eligibility
minclaw skills sync  fetch skill catalog from GitHub
minclaw skills install <name>  install a skill's deps
minclaw skills info <name>     show skill details
minclaw help         show help
```

<p align="center">
  <img src="public/minclaw-sessions.png" width="700" alt="MinClaw session browser" /><br/>
  Manage and view sessions in terminal
</p>

## Channels

**Terminal** is always available — just run `minclaw`. For messaging channels, use the connect wizard:

### WhatsApp

```bash
minclaw connect wa
```

Walks you through it — enables WhatsApp in config, shows a QR code, you scan it, done. Auth is saved in `.wa-auth/` so you only scan once. Reconnects automatically.

### Telegram

```bash
minclaw connect tg
```

Prompts for your bot token (get one from [@BotFather](https://t.me/BotFather) — send `/newbot`). Verifies the token, enables Telegram in config, and offers to save the token to `.env`. Then just `minclaw restart`.

### Slack

```bash
minclaw connect slack
```

Prompts for your Bot Token (`xoxb-...`) and App Token (`xapp-...`). To get these:

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Socket Mode** (gives you the `xapp-` token)
3. Add Bot Token Scopes: `chat:write`, `app_mentions:read`, `im:history`, `im:read`, `im:write`
4. Install to workspace (gives you the `xoxb-` token)

The wizard verifies both tokens, enables Slack in config, and saves to `.env`.

### Access control

Each channel has an `allowFrom` list in `minclaw.json5`. Leave it empty to allow everyone, or restrict:

```json5
"telegram": { "enabled": true, "allowFrom": ["@yourusername"] }
"whatsapp": { "enabled": true, "allowFrom": ["+1234567890"] }
```

## Architecture

```
~/.minclaw/           state directory
  credentials.json      auth credentials
  daemon.pid            PID file
  daemon.sock           Unix socket (daemon <-> CLI)
  logs/daemon.log       daemon logs

minclaw.json5         project config
skills/                 stolen openclaw skills (cached locally)
sessions/               JSONL transcripts per sender
memory/                 markdown chat history + temporary-memory.md index
```

Daemon runs in background. CLI clients connect via Unix socket using NDJSON protocol. Multiple terminals supported simultaneously.
