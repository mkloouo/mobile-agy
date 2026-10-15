# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Vitest test suite (`tests/`) and `AGENTS.md` enforcing test coverage across the project.
- Media group / album batching in Telegram: buffers multiple photos and loads in batches of 5 before launching the prompt.

### Changed
- Throttled status message edits to 2.5s with automatic Telegram 429 cooldown backoff.

### Fixed
- Telegram 429 rate limits no longer swallow responses: graceful fallback to `sendMessage` on edit errors.
- Direct shell commands (`! <cmd>`) now attach listeners synchronously, preventing lost output on fast-exiting commands.
- Prevented premature turn timeouts by refreshing activity timers on every agent event during long research tasks.
- Fixed Unix socket session recovery across PM2 restarts by preserving message IDs in daemon state.

## [1.0.0] - 2026-10-15
- Initial release of mobile-agy Telegram interface for Google Antigravity CLI.
