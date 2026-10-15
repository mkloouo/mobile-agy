<div align="center">

```
           / _ \
         \_\(_)/_/
          _// \\_
           /   \
  __  __  ___  ___ ___ _    ___     _   _____   __
 |  \/  |/ _ \| _ )_ _| |  | __|   /_\ / __\ \ / /
 | |\/| | (_) | _ \| || |__| _|   / _ \ (_ |\ V / 
 |_|  |_|\___/|___/___|____|___|_/_/ \_\___| |_|  
```

# mobile-agy

### Control Google Antigravity CLI from anywhere — straight from Telegram.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square&logo=node.js)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey?style=flat-square)](https://github.com/mkloouo/mobile-agy)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

*Direct inspiration: [Remoat](https://github.com/optimistengineer/remoat) and the futile efforts of wrestling with CDP/DOM scraping that brought this native headless architecture to life.*

</div>

---

**mobile-agy** connects Telegram directly to Google Antigravity CLI (`agy`) using its native, warm **`stream-json`** protocol. No Electron GUI, no Chrome DevTools Protocol, and no brittle DOM scraping.

## Highlights

- 🕷️ **Zero Friction**: Native headless streaming (`agy --input-format stream-json --output-format stream-json`) directly on your machine.
- 💬 **Topic-Per-Conversation**: Automatic forum topic creation for every session and project.
- ⚡ **Direct Shell & Kill Switch**: Execute commands with `! <cmd>` and kill running tasks instantly via inline buttons or `/kill`.
- ⚙️ **Background Server Awareness**: Live tracking and stop buttons for active dev servers (Metro bundler, Expo, Next.js).
- 🤖 **Model Switching**: Change reasoning models on the fly with `/model` (`gemini-3.8-flash-medium`, `gemini-3.8-flash-high`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`).
- 🗜️ **Context Management**: Fast transcript compaction with `/compact` and quota monitoring with `/quota`.
- ❓ **Interactive Choices**: Surfaces model `ask_question` dialogs with clickable Telegram buttons.
- 📸 **Mobile Media**: Send screenshots or photos straight from your phone.
- 🔒 **Private & Secure**: User whitelist restriction (`ALLOWED_USER_IDS`).

---

## Quick Start

### 1. Requirements

- macOS or Linux with [`agy`](https://antigravity.dev) logged in.
- Node.js >= 18.
- Telegram Bot Token from [@BotFather](https://t.me/BotFather).

### 2. Install & Link

```bash
npm install
npm run build
npm link
```

### 3. Setup & Configure

Run the interactive setup wizard:
```bash
mobile-agy setup
```

Or configure `.env`:
```env
TELEGRAM_BOT_TOKEN=123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ
ALLOWED_USER_IDS=826906943
WORKSPACE_BASE_DIR=/Users/mkloouo/Projects
DEFAULT_MODEL=gemini-3.8-flash-medium
USE_TOPICS=true
AUTO_APPROVE=true
IDLE_TIMEOUT_SECONDS=300
```

### 4. Run

```bash
mobile-agy
```

Or as a persistent background daemon with **PM2**:
```bash
pm2 start dist/bin/cli.js --name "mobile-agy" -- start
pm2 save
```

---

## Commands

### Control & Execution

| Command | Action |
| :--- | :--- |
| `! <cmd>` | Execute shell command directly with live streaming and instant Stop button |
| `/model [name]` | Switch AI model for topic (`gemini-3.8-flash-medium`, `claude-sonnet-4-6`, etc.) |
| `/queue` | View queued prompts, **Force Run Now** (`⚡ Force`), or clear queue |
| `/stop` | Cancel active Antigravity turn |
| `/kill [pid]` | Terminate background command or running dev server (Expo, Next.js, Metro) |
| `/restart` | Restart warm session daemon and reload tools / MCP environment |
| `/status` | View session status, bound & active workspaces, model, and active servers |

### Workspaces & Navigation

| Command | Action |
| :--- | :--- |
| `/bind <path>` | Bind current topic to any folder path (`~`, `/Users/...`, `/etc`, arbitrary) — aliases: `/cd`, `/workspace` |
| `/new [title]` | Create a new topic and start a fresh session (alias: `/agy_new`) |
| `/projects` | Browse workspace projects with inline buttons and auto-create topics |
| `/chats [query]` | Search and attach past conversations with pagination |
| `/resume <uuid>` | Attach a specific conversation ID to current topic |
| `/topic <name>` | Rename current topic |
| `/clear` | Clear active conversation in this topic (keeps workspace binding) — alias: `/reset` |

### Context & Quota

| Command | Action |
| :--- | :--- |
| `/compact [focus]` | Compact transcript & context window |
| `/quota` | View remaining 5-hour and weekly quota across all models (alias: `/usage`) |
| `/help` | View help and available slash commands |

### Files, Logs & Photos

- **Large Log Pasting**: Paste massive logs directly into Telegram chat. The bot automatically debounces and batches Telegram's 4KB split messages into a single assembled prompt.
- **Log File Uploads**: Send `.log`, `.txt`, `.json` document files. Small files are read into the prompt; large files are downloaded and referenced for tool inspection.
- **Screenshots & Media**: Send single photos or photo albums (batched automatically).

### Native Antigravity Commands

The following slash commands pass directly to `agy`:
`/plan`, `/goal`, `/learn`, `/grill-me`, `/boost`, `/browser`, `/schedule`, `/teamwork-preview`, `/caveman`, `/ponytail`, `/review`, `/audit`.

---

## Architecture

Unlike desktop CDP remotes, `mobile-agy` spawns an isolated Unix socket daemon for each topic running `agy` in native `stream-json` mode:

```
Telegram ──> Grammy Bot ──> Unix Domain Socket ──> sessionDaemon ──> agy (stream-json)
                                                         │
                                               Live Task Tracker (PID/Port)
```

- **Warm Process Pooling**: Fast follow-ups without re-initializing tools.
- **Fail-Safe Detached Daemon**: Sessions survive bot restarts and reconnect automatically.

---

## License

MIT
