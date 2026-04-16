# Contributing to Copilot Spawner

Thanks for your interest — this is a small, opinionated project, and contributions that keep it that way are very welcome.

## Ground rules

- **Readable over clever.** The whole point of this repo is that the server is one file, the frontend is three files, and anyone can understand the code in an afternoon. PRs that double the line count for a 5% feature will be politely declined.
- **No new hard dependencies** unless there is a very good reason. `aiohttp` and `xterm.js` are enough for almost everything.
- **Match the existing style.** Four-space indent in Python, tab indent in HTML/CSS/JS (mirroring the Status upstream). No linters wired up yet; just keep it tidy.

## Development setup

```bash
git clone https://github.com/MauroDruwel/Copilot-Spawner.git
cd Copilot-Spawner
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export COPILOT_SPAWNER_PASSWORD='dev'
python app.py
```

The server reloads nothing automatically — restart it after editing `app.py`. Static assets in `html/` are served live, so browser refresh is enough.

If you don't have the Copilot CLI installed, you can still test the UI by setting `COPILOT_BIN=/bin/bash` — the explorer, session manager, and terminal all work against any PTY-friendly binary.

## Project layout

```
app.py             # aiohttp server: auth, explorer, PTY session manager, WebSocket terminal
html/
  index.html       # main SPA shell
  login.html       # standalone login page
  css/main.css     # all styles (adapted from dani3l0/Status)
  js/app.js        # explorer, sessions, terminal, forms
  js/login.js      # theme restore + login POST
  js/main.js       # hash router, page bootstrap (from Status)
  js/utils.js      # DOM helpers and theme picker (from Status)
requirements.txt   # aiohttp only
docs/              # banner + screenshots for README
workspace/         # user-created folders, git clones, etc.
```

## Making a change

1. **Open an issue first** for anything non-trivial — it's much faster than writing a PR that doesn't fit.
2. Work on a feature branch: `git checkout -b feat/short-name`.
3. Keep commits focused. A good commit message looks like `server: limit session log to configured max bytes` — subject in imperative mood, details in the body if needed.
4. Test end to end in a browser. There is no test suite yet; adding one is a great first PR.
5. Open the PR against `main` with a clear description: what, why, and how you tested.

## Things that are always welcome

- Bug reports with a reproduction.
- Security reports (see [SECURITY.md](SECURITY.md) — please don't open a public issue).
- Documentation fixes, screenshot refreshes, typo patches.
- Small quality-of-life improvements that don't expand the surface area.

## Things to discuss first

- Anything that changes the auth model.
- Adding a database or any persistence beyond the workspace folder.
- New runtime dependencies.
- Packaging changes (Docker image, Python package on PyPI, etc.).

## Releasing

Tags follow semver: `v0.1.0`, `v0.2.0`, …. The project has no automated release pipeline yet — cutting a release means tagging the commit and writing release notes on GitHub.

## Code of conduct

By participating, you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

---

Thanks again. Keep it small, keep it readable, and have fun.
