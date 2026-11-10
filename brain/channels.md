# Channels

## Connecting Channels

The user can connect channels using the `minclaw connect` wizard from their terminal. If a user asks how to set up or connect a channel, guide them through the process below.

### WhatsApp
```
minclaw connect wa
```
1. The wizard enables WhatsApp in `minclaw.json5` automatically
2. A QR code appears in the terminal
3. User opens WhatsApp on their phone > Linked Devices > Link a Device
4. Scans the QR code — done
5. Auth is saved in `.wa-auth/` so they only need to scan once
6. Reconnects automatically on daemon restart

No tokens or API keys needed — just scan the QR code.

### Telegram
```
minclaw connect tg
```
1. User needs a bot token from @BotFather on Telegram:
   - Open Telegram, search for @BotFather
   - Send `/newbot` and follow the prompts
   - Copy the bot token
2. The wizard verifies the token, enables Telegram in config, and offers to save the token to `.env`
3. After connecting, restart the daemon: `minclaw restart`

Environment variable: `TELEGRAM_BOT_TOKEN`

### Slack
```
minclaw connect slack
```
1. User needs to create an app at https://api.slack.com/apps
2. Enable **Socket Mode** (gives them an App-Level Token: `xapp-...`)
3. Add Bot Token Scopes: `chat:write`, `app_mentions:read`, `im:history`, `im:read`, `im:write`
4. Install to workspace (gives them a Bot Token: `xoxb-...`)
5. The wizard verifies both tokens, enables Slack in config, and saves to `.env`
6. After connecting, restart the daemon: `minclaw restart`

Environment variables: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`

### Access Control

Each channel has an `allowFrom` list in `minclaw.json5`. Empty = allow everyone. To restrict:
```
"telegram": { "enabled": true, "allowFrom": ["@yourusername"] }
"whatsapp": { "enabled": true, "allowFrom": ["+1234567890"] }
```

## Channel Behavior Rules

### WhatsApp
- Max message length: ~65,000 chars (but keep responses under 4,000 for readability)
- No markdown rendering — use plain text, line breaks, and emoji sparingly
- Avoid code blocks; use indentation if showing code snippets

### Telegram
- Max message length: 4,096 chars per message
- Native HTML conversion: standard Markdown (`### Headings`, `**bold**`, `*italic*`, `~~strike~~`, `[links](url)`, `` `code` ``, ````code blocks````, and lists) is automatically converted into native Telegram HTML entities.
- **Bot API 10.4 Dark-Mode Interactive Widgets (`send_widget`)**:
  - Delivers cards styled natively for Telegram dark mode (`#17212b`).
  - Supports structured key/value item rows, optional custom HTML bodies, and interactive 1-tap inline buttons.
  - **Supported Action Commands** on button tap:
    - `double_remind:<ISO_START>:<EVENT_TITLE>`: sets 1h and 30m alerts simultaneously in both Telegram and Google Calendar with one tap.
    - `remind:<MINUTES_BEFORE>:<ISO_START>:<EVENT_TITLE>`: sets an alert N minutes prior to event start.
    - `job_delete:<JOB_ID>`: cancels and deletes a scheduled job/reminder.
    - `job_run:<JOB_ID>`: triggers immediate execution of a scheduled job.
    - `email_seen:<ACCOUNT_ID>_<MSG_ID>`: marks an email as read/seen.
    - `ask:<NATURAL_LANGUAGE_PROMPT>`: executes a follow-up agent turn with the given prompt.
  - **When to Use**:
    - Calendar events, appointments, and schedules (always offer a 1-tap `double_remind` button).
    - Morning briefings, heartbeat status updates, and reflex email triage.
    - Scheduled jobs and dashboard summaries.
  - When returning a widget, keep accompanying plain text brief to avoid duplicate clutter.
- Split long responses into multiple messages if needed

### Slack
- Max message length: 40,000 chars
- Supports Slack mrkdwn: *bold*, _italic_, `code`, ```code blocks```
- Use threaded replies when continuing a conversation

### Terminal (CLI)
- No length limits
- Full markdown supported
- Can use code blocks freely
