# MinClaw Operational Memory & Experience Library (Level 2 Experience)

> [!NOTE]
> This operational memory is a persistent experience library that records operational heuristics, tool quirks, and CLI workarounds across sessions, independent of human personal preferences. Agents running under MinClaw should consult these patterns before executing tools and update this document when discovering new enduring platform quirks.

## 🛠️ Tool & API Quirks

### 1. Built-in Tool Calling Syntax
- MinClaw tools can be invoked in a single step via the CLI without running interactive sessions:
  `bun run src/cli.ts tool call <tool_name> <arg_name>=<arg_value> ...`
  or via the installed binary:
  `minclaw tool call <tool_name> <arg_name>=<arg_value> ...`
- Key-value arguments with spaces or special characters MUST be quoted in shell invocations (e.g., `query="search term"`).

### 2. Email Tool (`email`) & Himalaya
- **Listing Unread**: Use `action=list_unread limit=10` to query unread messages across configured Google accounts.
- **Reading Emails**: Requires both `id` and `account` parameters (e.g., `action=read id="<message_id>" account="<account_name>"`).
- **Sending Emails**: Requires `to`, `subject`, and `body` parameters.
- **University Email (UdS HIZ IMAP)**: Student email (`assu00001@stud.uni-saarland.de`) is routed via Himalaya CLI (`himalaya -a imap_assu00001_stud_uni_saarland_de envelope list / message read <id>`). Note that `~/.config/himalaya/config.toml` requires reading outside the sandboxed workspace.
- **IMAP Search Nuance**: IMAP servers may return partial headers if envelopes are unread; MinClaw expands envelope fetches and filters out `\Seen` flags locally to ensure accurate triage.

### 3. Calendar Tool (`calendar`)
- **Event Listing**: `action=list_events limit=10` lists upcoming calendar entries.
- **Event Creation**: Requires `summary` and `startTime` formatted as standard ISO 8601 strings (e.g., `2026-10-27T18:00:00Z` or `2026-10-27T19:00:00+02:00`).
- **AppleScript Timeouts**: On macOS, accessing local Calendar.app via AppleScript may trigger system permission prompts or hang if Calendar.app is unresponsive. Keep queries bounded with reasonable timeouts.

### 4. YouTube & Media (`youtube`)
- **Instant Playback in Firefox**: Use `action=play query="<query>" browser="Firefox"` to launch playback in Firefox directly.
- **Fast Search**: `action=search query="<query>"` returns top YouTube video matches without opening a browser window.

### 5. Web Search & SearXNG
- **Concise Keyword Queries**: SearXNG and detail search engines perform best with keyword-rich phrases rather than conversational questions (e.g., `"Bun spawn pipe stderr"` instead of `"how do I handle stderr piping in Bun spawn?"`).
- **URL Fetching**: Always verify HTTP response status codes before attempting to parse HTML content.

### 6. Scheduled Jobs & Reminders (`list_scheduled_jobs`, `schedule_reminder`, `cancel_scheduled_job`)
- **Storage Location**: Scheduled jobs are persisted to `sessions/scheduled-jobs.json` (gitignored).
- **One-Shot Auto-Pruning Invariant**: One-shot reminders (e.g. `when="tomorrow at 10am"` or `when="in 15m"`) are created with `oneShot: true`. The moment they fire, `scheduler.ts` executes `removeJob(job.id)`, immediately deleting them from `sessions/scheduled-jobs.json`. Only recurring cron jobs (`0 8 * * *`, `oneShot: false`) persist indefinitely.
- **Natural Language Parsing**: Use format `at 8pm`, `in 15m`, or `every day at 9am`. Colloquial compounds like `tonight around 8pm` are rejected by the parser; normalize to `at 8pm`.
- **Arbitrary Calendar Dates**: The default `schedule_reminder` tool only handles relative times and simple day markers (today/tomorrow). For arbitrary future dates (e.g., `"Nov 24 at 2:30pm"`, `"2026-11-24 14:00"`, `"24.11.2026 15:00"`), use the standalone helper script:
  `bun run scripts/schedule-date-reminder.ts --when="<date/time>" --message="<text>" [--name="<title>"]`
  which parses natural date strings into ISO timestamps and adds the one-shot job directly into `sessions/scheduled-jobs.json`.
- **Fast Single-Step Inspection**: Always use `bun run src/cli.ts tool call list_scheduled_jobs` (or direct tool call `list_scheduled_jobs`) instead of searching files or chat logs.
- **Cancellation**: Use `bun run src/cli.ts tool call cancel_scheduled_job id="<job-id>"`.

### 7. Interactive Widgets (`send_widget`)
- **CLI String vs Array Arguments**: When invoking `send_widget` via the CLI, argument flags like `items` and `actions` are passed as JSON strings rather than native runtime objects. To prevent crashes or raw string interpolation in fallback text and widget builders, ensure JSON strings are parsed before iterating, or use the dedicated helper script:
  `bun run scripts/send-widget.ts --title="<title>" --body="<body>" [--items="<json>"] [--actions="<json>"]`
  which normalizes stringified JSON properties and converts `items` into dark-mode HTML natively if needed.
- **Action Buttons**: Support interactive commands including `double_remind:<ISO_START>:<TITLE>`, `remind:<MINUTES_BEFORE>:<ISO_START>:<TITLE>`, `job_delete:<JOB_ID>`, `job_run:<JOB_ID>`, `email_seen:<ACCOUNT_ID>_<MSG_ID>`, and `ask:<PROMPT>`.

---

## 🧠 Environment & Platform Gotchas

### 1. Daemon Host Process & Suicide Prevention Guard
- **NEVER kill or restart MinClaw**: Calling `minclaw restart`, `bun run src/cli.ts restart`, `minclaw stop`, or killing the parent PID will immediately terminate the running turn, drop channel connections, and leave the daemon in an unrecoverable stopped state.
- MinClaw incorporates internal guards (`MINCLAW_IS_DAEMON=1`), but autonomous agents must strictly avoid issuing daemon lifecycle commands during interactive turns.

### 2. Runtime Sockets and Process State
- MinClaw daemon stores its control socket at `~/.minclaw/minclaw.sock` and PID at `~/.minclaw/minclaw.pid`.
- Do not remove or corrupt these files while the daemon is actively running.
- In multi-turn fallback sessions, Antigravity conversation IDs are mapped to session keys to maintain prompt caching and conversation continuity.

### 3. Bun vs Node Subprocess Execution
- Subprocesses executed via `Bun.spawn` inherit environment variables, but Bun resolves relative file paths relative to `process.cwd()` rather than the script directory. Always use `resolve()` or absolute paths when pointing to workspace assets.
- When reading output streams from `Bun.spawn`, remember that streams must be consumed or drained to prevent subprocess deadlock.

### 4. macOS Sandbox & Permissions Nuances
- Automated scripts accessing Calendar, Contacts, Microphone, or System Events (via AppleScript) require macOS TCC (Transparency, Consent, and Control) permissions.
- If an AppleScript call fails with execution error -1743 (not authorized to send Apple events), alert the user to grant permission in macOS System Settings > Privacy & Security > Automation.

---

## 📜 Golden Operational Patterns

### 1. Single-Step CLI Execution (Zero Discovery Waste)
- Never waste turns writing temporary scratch scripts (`bun -e ...`) to inspect how tools work. The built-in CLI handles argument parsing, OAuth token refresh, and formatting automatically.
- Use `bun run src/cli.ts tool call <name> ...` directly.

### 2. Read Before Edit
- Always read existing files (`read_file`) before applying edits (`edit_file`). Verifying exact lines, indentation, and existing imports prevents failed replacements and regressions.

### 3. Autonomous Step Budget (5 + 5 Hard Cap)
- Limit tool executions to a maximum budget of 5 steps for normal requests, extending to at most 10 steps only when complex multi-stage inspection is strictly necessary.
- Stop calling tools at or before step 10 and synthesize the final response for the user.

### 4. Decoupled Self-Improvement
- Never edit `src/` files or run test suites in response to live user chat turns.
- If a missing capability or bug is discovered during a user interaction, queue it via:
  `bun run src/cli.ts tool call queue_self_improvement title="..." description="..."`
  and proceed to answer the user's immediate request directly.

### 5. Recording Enduring Heuristics
- When encountering reproducible API limitations, unexpected platform errors, or reliable workarounds, append them to this document (`brain/operational-memory.md`) so that subsequent agent invocations inherit the knowledge.
