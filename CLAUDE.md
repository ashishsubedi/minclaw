# MinClaw

A self-improving AI agent reachable via Telegram, WhatsApp, Slack, and terminal. Runs as a background daemon with a CLI chat interface.

## Project Structure

```
minclaw/
├── src/
│   ├── cli.ts                # CLI entry point — dispatches subcommands
│   ├── index.ts              # Daemon entry point — channels, scheduler, socket server
│   ├── config.ts             # Loads minclaw.json5
│   ├── router.ts             # Message in → command check → agent → reply
│   ├── agent.ts              # Anthropic API caller (OAuth + API key)
│   ├── session.ts            # JSONL transcript storage per sender
│   ├── auth/
│   │   ├── credentials.ts    # ~/.minclaw/credentials.json + token refresh
│   │   └── oauth.ts          # Anthropic OAuth PKCE flow
│   ├── brain/
│   │   └── loader.ts         # Reads brain/ markdown files (system, memory, heartbeat, channels)
│   ├── cli/
│   │   ├── chat.ts           # Terminal chat REPL (connects to daemon)
│   │   ├── daemon-ctl.ts     # start/stop/restart/status/logs
│   │   └── setup.ts          # Interactive setup wizard
│   ├── daemon/
│   │   ├── server.ts         # Unix socket server for CLI clients
│   │   └── protocol.ts       # NDJSON message types
│   ├── channels/
│   │   ├── types.ts          # ChannelAdapter, IncomingMessage, ReplyFn
│   │   ├── telegram.ts       # Grammy
│   │   ├── whatsapp.ts       # Baileys
│   │   └── slack.ts          # Bolt
│   ├── memory/
│   │   └── store.ts          # MD-based chat storage + search + temporary-memory.md index
│   ├── skills/
│   │   ├── types.ts          # SkillEntry, SkillMetadata, SkillStatus types
│   │   ├── frontmatter.ts    # SKILL.md parser (YAML frontmatter + JSON5 metadata)
│   │   ├── catalog.ts        # Fetch/cache skill catalog from GitHub API
│   │   ├── eligibility.ts    # Check binary/env presence, OS match
│   │   ├── installer.ts      # Install skill deps via Bun.spawn
│   │   └── loader.ts         # Build skills prompt section for agent
│   ├── scheduler/
│   │   ├── scheduler.ts      # Programmatic job scheduling (remind me at X)
│   │   └── heartbeat.ts      # Recurring cron heartbeat
│   └── tui/
│       └── viewer.ts         # Legacy session viewer
├── brain/                    # Human-editable agent personality & knowledge
│   ├── system.md             # Identity, personality, guidelines, commands
│   ├── permanent-memory.md   # Persistent knowledge (user-curated facts/notes)
│   ├── heartbeat.md          # Instructions for heartbeat cron
│   └── channels.md           # Per-channel behavior rules
├── minclaw.json5           # Config (workspace dir)
├── skills/                   # Cached skill files from openclaw (gitignored)
│   ├── catalog.json          # Skill index
│   └── <name>/SKILL.md       # Downloaded skill definitions
├── memory/                   # Chat markdown files + temporary-memory.md index
├── sessions/                 # JSONL transcripts
└── package.json
```

## CLI Usage

```
minclaw              # Chat with agent (connects to daemon)
minclaw setup        # Configure credentials (OAuth or API key)
minclaw start        # Start daemon in background
minclaw stop         # Stop daemon
minclaw restart      # Restart daemon
minclaw status       # Show daemon status
minclaw logs         # Show daemon logs
minclaw skills       # List skills with eligibility status
minclaw skills sync  # Fetch catalog from GitHub
minclaw skills install <name>  # Install a skill's deps
minclaw skills info <name>     # Show skill details
```

## Architecture

- **Daemon** (`src/index.ts`): Runs in background, manages channels, scheduler, heartbeat. Listens on `~/.minclaw/daemon.sock` (Unix socket, NDJSON protocol).
- **CLI** (`src/cli.ts`): Dispatches to subcommands. `minclaw` (no args) = chat.
- **Chat** (`src/cli/chat.ts`): REPL that connects to daemon socket. Each terminal gets session `terminal:<pid>`.
- **Auth**: Anthropic OAuth PKCE or plain API key. Stored in `~/.minclaw/credentials.json`. Env var `ANTHROPIC_API_KEY` always takes priority.

## Skills

Skills are specialized instruction sets from the [openclaw](https://github.com/openclaw/openclaw) catalog. Each skill is a `SKILL.md` file with YAML frontmatter containing metadata (required binaries, env vars, install specs) and a markdown body with usage instructions.

- Skills are fetched from GitHub and cached in `skills/` (gitignored)
- Eligible skills (binaries present) are injected into the agent's system prompt
- `/skills` command in chat lists available skills; `/skills sync` refreshes the catalog
- `src/skills/` contains the skill system: types, parser, catalog, eligibility, installer, loader

## State Directories

- `~/.minclaw/` — credentials, PID file, socket, logs
- `./skills/` — cached skill definitions (from openclaw catalog)
- `./memory/` — chat markdown files
- `./sessions/` — JSONL transcripts

## Runtime

- Use Bun, not Node.js
- `bun link` to install `minclaw` globally
- Config watcher: daemon reloads heartbeat/scheduler on `minclaw.json5` change; channel changes require restart
