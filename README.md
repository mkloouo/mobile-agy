# mobile-friendly-agy

A lightweight, mobile-friendly Telegram bot interface for **Google Antigravity CLI (`agy`)**.

Unlike desktop CDP-based remotes, `mobile-friendly-agy` connects directly to the Antigravity CLI using its native, warm **`stream-json`** protocol. No Electron desktop app, no Chrome DevTools Protocol, and no brittle DOM scraping.

---

## Features

- **Automatic Topic Per Conversation**: In forum-enabled supergroups, every new prompt outside a topic, every `/new [title]`, and every `/projects` selection automatically creates a dedicated Telegram Forum Topic.
- **Native Headless Streaming**: Uses `agy --input-format stream-json --output-format stream-json` directly on your Mac.
- **Zero API Key Hassle**: Uses your existing logged-in Antigravity account, plugins, MCP servers, and custom skills automatically.
- **Live Output Streaming**: Throttled live text editing in Telegram with emoji status indicators for tool executions (e.g. `⚙️ Executing: run_command`).
- **Project Switching**: Switch between projects in your workspace with `/projects` via interactive inline buttons (auto-creates a project topic).
- **Multi-turn Sessions**: Retains conversation history across turns within each topic and recovers seamlessly across restarts.
- **Media Support**: Send screenshots and photos from your mobile phone—the bot downloads them to a local temporary path and attaches them to the prompt.
- **Task Control**: Abort running tasks on the fly with `/stop`.
- **Security**: Whitelist protection via `ALLOWED_USER_IDS`.

---

## Getting Started

### 1. Requirements

- macOS or Linux with `agy` (Antigravity CLI) installed and logged in.
- Node.js >= 18.
- A Telegram Bot Token from [@BotFather](https://t.me/BotFather).

### 2. Build & Link Global Binary

```bash
npm run build
npm link
```

### 3. Quick Setup

Run the interactive setup wizard:

```bash
mobile-agy setup
```

Or copy `.env.example` to `.env` and fill in your values:

```env
TELEGRAM_BOT_TOKEN=123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ
ALLOWED_USER_IDS=12345678
WORKSPACE_BASE_DIR=/Users/mkloouo/Projects
USE_TOPICS=true
AUTO_APPROVE=true
# Keep warm agy processes alive for fast follow-up replies (default 300 seconds = 5m)
IDLE_TIMEOUT_SECONDS=300
```

> **Tip:** You can get your numeric Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot).

### 4. Run the Bot

From anywhere in your terminal:

```bash
mobile-agy
```
*(Alias: `agy-telegram`)*

Or in development mode with auto-reload:
```bash
npm run dev
```

---

## Bot Commands

| Command | Description |
| :--- | :--- |
| `/agy_new [title]` | Create a new topic and start a fresh conversation |
| `/agy_chats [query]` | Browse recent Antigravity conversations with pagination/search and assign to a topic |
| `/agy_projects` | List available workspace directories with inline selection buttons |
| `/agy_resume <id>` | Attach an existing Antigravity conversation ID to the current topic |
| `/agy_bind <workspace>` | Bind current topic to a specific workspace directory |
| `/agy_topic <name>` | Rename the current Telegram forum topic |
| `/agy_stop` | Immediately interrupt and terminate the running agent turn or warm process |
| `/agy_status` | View current workspace directory, active conversation UUID, and task state |
| `/agy_help` | Display quickstart guide and available commands |

---

## Optional: Run 24/7 in Background on macOS

You can run this as a persistent background daemon using `pm2`:

```bash
npm install -g pm2
pm2 start dist/bin/cli.js --name "mobile-agy" -- start
pm2 save
pm2 startup
```
