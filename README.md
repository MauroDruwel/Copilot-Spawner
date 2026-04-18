<p align="center">
	<img src="docs/banner.svg" alt="Copilot Spawner banner" width="100%">
</p>

<h1 align="center">Copilot Spawner</h1>

<p align="center">
	Self-hosted web UI for running and managing GitHub Copilot CLI sessions.
</p>

<p align="center">
	<a href="https://www.python.org/"><img alt="Python" src="https://img.shields.io/badge/python-3.10%2B-3776AB?logo=python&logoColor=white"></a>
	<a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-4c1"></a>
	<a href="https://github.com/aio-libs/aiohttp"><img alt="aiohttp" src="https://img.shields.io/badge/aiohttp-%E2%89%A53.9-2C5BB4"></a>
	<a href="https://github.com/MauroDruwel/Copilot-Spawner/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/MauroDruwel/Copilot-Spawner/actions/workflows/ci.yml/badge.svg"></a>
	<a href="https://github.com/MauroDruwel/Copilot-Spawner/actions/workflows/release.yml"><img alt="Release" src="https://github.com/MauroDruwel/Copilot-Spawner/actions/workflows/release.yml/badge.svg"></a>
</p>

## What it does

Copilot Spawner gives you a clean web interface to:

- browse folders in a workspace
- start Copilot CLI sessions (`--remote` / `--yolo`)
- watch and interact with live PTY terminals in-browser
- stop/delete sessions
- resume from recent history
- clone repos, create folders, and invite collaborators

## Install (recommended: Copilot CLI)

Copy/paste this in Copilot CLI:

```text
Deploy Copilot Spawner on this Linux machine using https://raw.githubusercontent.com/MauroDruwel/Copilot-Spawner/main/docs/copilot-cli-deploy-prompt.md
```

The prompt asks setup questions first (including whether to create a user `systemd` service), defaults to stable releases, and supports `uv` or `venv + pip`.

## Manual install

Stable install (latest release tag):

```bash
git clone https://github.com/MauroDruwel/Copilot-Spawner.git
cd Copilot-Spawner
git fetch --tags
git checkout "$(git describe --tags --abbrev=0)"
```

### Option A: `uv` (recommended)

```bash
uv venv .venv
.venv/bin/uv pip install -r requirements.txt

export COPILOT_SPAWNER_PASSWORD='change-me'
export COPILOT_SPAWNER_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
.venv/bin/python app.py
```

### Option B: `.venv` + `pip`

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open: <http://127.0.0.1:8765>

## Demo

- Video walkthrough: [copilot-spawner-demo.webm](docs/demo/copilot-spawner-demo.webm)

## Screenshots

<p>
	<img src="docs/screenshots/01-main-dark-red.png" alt="Main screen" width="100%">
</p>
<p>
	<img src="docs/screenshots/02-explorer-dark-lightblue.png" alt="Explorer screen" width="100%">
</p>
<p>
	<img src="docs/screenshots/03-sessions-dark-green.png" alt="Sessions screen" width="100%">
</p>

## Configuration

| Variable | Default | Description |
|---|---|---|
| `COPILOT_SPAWNER_PASSWORD` | auto-generated | Login password (set explicitly for production) |
| `COPILOT_SPAWNER_SECRET` | auto-generated | Cookie signing secret |
| `COPILOT_SPAWNER_HOST` | `127.0.0.1` | Bind host |
| `COPILOT_SPAWNER_PORT` | `8765` | Bind port |
| `COPILOT_WORKSPACE` | `./workspace` | Explorer root |
| `COPILOT_BIN` | `copilot` | Copilot CLI binary path |
| `GITHUB_TOKEN` | unset | Needed for collaborator invites |

## Releases

- Tags use `vX.Y.Z` format (example: `v0.1.0`).
- Pushing a version tag triggers the Release workflow automatically.
- You can also trigger release manually via **Actions → Release** with a version input.

## Security notes

- Keep it behind localhost + reverse proxy for public access.
- Set strong values for `COPILOT_SPAWNER_PASSWORD` and `COPILOT_SPAWNER_SECRET`.
- Use TLS termination (for example Cloudflare Tunnel or Nginx/Caddy).

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Mauro Druwel
