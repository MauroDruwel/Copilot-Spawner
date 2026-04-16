# Changelog

All notable changes to Copilot Spawner will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Cookie-based password authentication with HMAC-signed opaque tokens.
- Standalone `/login` page that preserves the theme picker.
- Real PTY sessions backed by `pty.fork()`, one process group per session.
- WebSocket endpoint `/api/sessions/{id}/ws` with bidirectional I/O and a JSON resize control frame.
- Interactive in-browser terminal powered by `xterm.js` and the fit addon.
- Session transcript ring buffer so reconnects replay history.
- Sign-out button in the main UI.
- Open-source polish: README with banner and screenshots grid, LICENSE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, GitHub issue/PR templates, and a CI workflow.

### Changed
- `/api/sessions/{id}/log` now serves a plain-text transcript of the retained output buffer.

### Security
- All `/api/*` endpoints (except `/api/login` and `/api/auth/status`) require a valid session cookie.
- Workspace path traversal attempts return `403`.
- Copilot is always invoked with a fixed `execvp` argv — no shell interpolation.

## [0.1.0] - 2026-04-16

### Added
- First public cut: explorer, per-folder spawn buttons (`play_arrow`, `bolt`), session list, clone form, new-folder form, GitHub contributor invites.
- Eight accent colors + light/dark theme (adapted from `dani3l0/Status`).
