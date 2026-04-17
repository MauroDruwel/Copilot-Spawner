# Copilot CLI Deployment Prompt

Copy this prompt into GitHub Copilot CLI on the target machine:

---

You are on a Linux machine. Set up and run **Copilot Spawner** as a **user systemd service** for the current user.

Before doing anything, ask me these questions and wait for answers:

1. Install tool: `uv` (recommended) or `venv + pip`.
2. Install location (default: `~/Copilot-Spawner`).
3. Port (default: `4510`).
4. Workspace path (default: `%h`).
5. Copilot binary path (default: `%h/.local/bin/copilot`).
6. Keep existing password/secret if present? (recommended: yes).

After I answer, proceed with these requirements:

1. Clone/update the repo at the selected path.
2. Create and use a Python virtual environment at `<install-path>/.venv`:
   - If `uv` was selected:
     - `uv venv <install-path>/.venv`
     - `<install-path>/.venv/bin/uv pip install -r <install-path>/requirements.txt`
   - If `venv + pip` was selected:
     - `python3 -m venv <install-path>/.venv`
     - `<install-path>/.venv/bin/pip install -r <install-path>/requirements.txt`
4. Create `~/.config/systemd/user/copilot-spawner.service` with:
   - `WorkingDirectory=<install-path>`
   - `ExecStart=<install-path>/.venv/bin/python <install-path>/app.py`
   - `Restart=always`
   - `RestartSec=3`
   - `Environment=COPILOT_SPAWNER_HOST=127.0.0.1`
   - `Environment=COPILOT_SPAWNER_PORT=<selected-port>`
   - `Environment=COPILOT_WORKSPACE=<selected-workspace>`
   - `Environment=COPILOT_BIN=<selected-copilot-bin>`
   - `Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin`
5. If `COPILOT_SPAWNER_PASSWORD` or `COPILOT_SPAWNER_SECRET` are missing in the service file:
   - set `COPILOT_SPAWNER_PASSWORD` to a strong generated password
   - set `COPILOT_SPAWNER_SECRET` to a generated 64-hex string
6. Run:
   - `systemctl --user daemon-reload`
   - `systemctl --user enable --now copilot-spawner.service`
7. Print:
   - service status (`systemctl --user --no-pager --full status copilot-spawner.service`)
   - listening URL
   - final service file contents.

Constraints:

- Do not use sudo.
- Do not modify global system services.
- Keep all changes in the current user's home directory.
- If a step fails, explain why and retry with a safe alternative.
- If `uv` is selected but not installed, ask whether to install it or fall back to `venv + pip`.

---
