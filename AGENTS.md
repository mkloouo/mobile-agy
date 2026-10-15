# mobile-agy

Mobile-friendly Telegram interface for Google Antigravity CLI via native `agy stream-json` protocol.
Enables headless, remote control and real-time streaming of Antigravity tasks without Electron or Chrome DevTools Protocol.

## Commands

- `npm run check` — typecheck with TypeScript (`tsc --noEmit`)
- `npm test` — run Vitest test suite (`vitest run`)
- `npm run build` — compile TypeScript and set executable permissions (`tsc && chmod +x dist/bin/cli.js`)
- `npm start` — run the compiled bot daemon (`node dist/bin/cli.js start`)
- `npm run dev` — run with ts-node-dev for local development

## Module Layout

- `src/bot/` — Telegram bot handlers using Grammy:
  - `commands.ts` — slash commands (`/agy_help`, `/status`, `/model`, `/usage`, `/projects`, `/chats`, etc.)
  - `messages.ts` — incoming text & photo routing, prompt construction
  - `mediaGroup.ts` — Telegram photo album / media group batching (loads in batches of 5 before launching turn)
  - `shell.ts` — direct shell command execution (`! <command>`), process group detachment, live output streaming
  - `turnExecutor.ts` — turn lifecycle, status editing, token usage tracking, and rate-limit fallbacks
  - `callbacks.ts` — inline button callback queries (model selection, workspace binding, process kill)
  - `keyboards.ts` — reusable inline keyboards
  - `queue.ts` — persistent queue management across PM2 restarts
  - `types.ts` — shared bot service interfaces
- `src/services/` — Core backend services:
  - `agyStreamService.ts` — Unix domain socket manager connecting to headless `sessionDaemon`
  - `sessionDaemon.ts` — detached background runner spawning `agy` in `stream-json` mode
  - `workspaceService.ts` — multi-project directory scanner and workspace resolver
  - `taskManager.ts` — background process tracker and PID tree killer
  - `telegramTopicManager.ts` — Telegram supergroup topic management
  - `conversationService.ts` — local conversation history scanner and resume cache
- `src/database/` — SQLite persistence (`better-sqlite3`) for sessions, workspace bindings, queues, and models
- `src/utils/` — formatting, sanitization, image downloads, and configuration

## Engineering & Testing Rules

1. **Mandatory Test Coverage**: Every functional change, parser, command, or bugfix must be accompanied by unit tests in `tests/` or maintain full test pass rates (`npm test`).
2. **Pre-flight Checks**: Always run `npm run check && npm test && npm run build` before committing or finishing a task. All checks must pass.
3. **No File Bloat**: Keep source files modular and under 400 lines of code. Extract pure utilities and dedicated handlers.
4. **Telegram Rate Limits (429)**: Status edits must be throttled (≥ 2.5s). Any final delivery or error message edit failure must gracefully fall back to `sendMessage` so responses are never lost or frozen in Telegram.
5. **No Broken Shell Commands**: Direct shell execution (`! <cmd>`) must attach stdio and close listeners synchronously upon spawn, before any async network calls.
6. **Changelog**: Keep `CHANGELOG.md` updated under `[Unreleased]` for any user-facing fixes or additions.
