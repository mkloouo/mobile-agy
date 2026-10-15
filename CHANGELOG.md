# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Interactive support for model `ask_question` tool calls: renders questions and options as Telegram inline keyboard buttons, supports single-select, multi-select, and skip, and submits the choice directly back to Antigravity CLI.

### Fixed
- Error delivery bug: fixed `turnExecutor` overriding network and execution errors with `✓ Done.` when turn response was blank.
- Plain-text entity decoding: added `decodeHtmlEntities` to prevent literal `&amp;`, `&lt;`, `&gt;` from being shown when falling back to plain text.
- Queued turn race condition: prevented subsequent queued turns from executing against a failing daemon by triggering session restart on fatal turn errors.
