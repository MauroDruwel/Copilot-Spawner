# Copilot Spawner Deployment Instructions (for Copilot CLI)

Use these instructions when a user asks Copilot CLI to deploy Copilot Spawner on Linux with a user systemd service.

## Ask first (required)

Before running commands, ask the user:

1. Install tool: `uv` (recommended) or `venv + pip`
2. Install path (default: `~/Copilot-Spawner`)
3. Install channel: `stable` (latest release tag, recommended) or `main`
4. Configure a user systemd service? `yes` (recommended) or `no`
5. Port (default: `8765`)
6. Workspace path (default: `<install-path>/workspace`)
7. Copilot binary path (default: `copilot`)
8. Keep existing password/secret in service file if present? (recommended: yes)

## Deployment tasks

1. Clone or update repo at chosen install path.
2. Checkout selected channel:
   - `stable`: `git fetch --tags` then `git checkout "$(git describe --tags --abbrev=0)"`
   - `main`: `git checkout main && git pull --ff-only origin main`
3. Create `.venv` and install dependencies:
   - `uv` path:
     - `uv venv <install-path>/.venv`
     - `<install-path>/.venv/bin/uv pip install -r <install-path>/requirements.txt`
   - `venv + pip` path:
     - `python3 -m venv <install-path>/.venv`
     - `<install-path>/.venv/bin/pip install -r <install-path>/requirements.txt`
4. If service mode is `yes`, write `~/.config/systemd/user/copilot-spawner.service`:
   - `WorkingDirectory=<install-path>`
   - `ExecStart=<install-path>/.venv/bin/python <install-path>/app.py`
   - `Restart=always`
   - `RestartSec=3`
   - `Environment=COPILOT_SPAWNER_HOST=127.0.0.1`
   - `Environment=COPILOT_SPAWNER_PORT=<selected-port>`
   - `Environment=COPILOT_WORKSPACE=<selected-workspace>`
   - `Environment=COPILOT_BIN=<selected-copilot-bin>`
   - `Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin`
5. Ensure secrets:
   - In service mode: set/update env lines in service file if missing
   - In non-service mode: print export commands for shell session
   - `COPILOT_SPAWNER_PASSWORD` should be strong random
   - `COPILOT_SPAWNER_SECRET` should be 64-hex random
6. Start:
   - Service mode: `systemctl --user daemon-reload` then `systemctl --user enable --now copilot-spawner.service`
   - Non-service mode: run `<install-path>/.venv/bin/python <install-path>/app.py`
7. Show results:
   - Service mode: `systemctl --user --no-pager --full status copilot-spawner.service`
   - Non-service mode: print exact run command and URL
   - URL (`http://127.0.0.1:<port>`)
   - If service mode, print final service file content

## Constraints

- Do not use `sudo`.
- Only create a **user** systemd service (`systemctl --user`).
- Keep all changes under the user home.
- If `uv` is chosen but missing, ask whether to install `uv` or switch to `venv + pip`.
