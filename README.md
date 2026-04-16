# Copilot Spawner

A tiny, pretty web app to spawn and manage GitHub Copilot agent sessions from
a folder explorer. UI is inspired by [dani3l0/Status](https://github.com/dani3l0/Status).

## Features

- Folder explorer for a configurable workspace directory
- One-click **copilot --remote** or **copilot --remote --yolo** per folder
- Session manager: view live output, stop, and remove sessions
- Create new folders inside the workspace
- Clone any git repository into the workspace
- Invite GitHub collaborators to a repo (requires `GITHUB_TOKEN`)
- Light/dark themes and eight accent colors — persisted in `localStorage`

## Requirements

- Python 3.10+
- `git` (for clone)
- The `copilot` CLI on `PATH` for session spawning

## Setup

```
pip install -r requirements.txt
```

## Run

```
python app.py
```

Then open http://127.0.0.1:8765

### Environment

| Variable | Default | Description |
|---|---|---|
| `COPILOT_WORKSPACE` | `./workspace` | Root folder shown in the explorer |
| `COPILOT_BIN` | `copilot` | Copilot CLI executable |
| `COPILOT_SPAWNER_HOST` | `127.0.0.1` | Bind host |
| `COPILOT_SPAWNER_PORT` | `8765` | Bind port |
| `COPILOT_SPAWNER_MAX_LOG` | `262144` | Max bytes of output kept per session |
| `GITHUB_TOKEN` | — | Token used to invite collaborators |

## API

- `GET /api/list?path=<rel>` — list folder contents
- `GET /api/sessions` — list sessions
- `POST /api/sessions/start` — body `{path, yolo}`
- `POST /api/sessions/{id}/stop`
- `GET /api/sessions/{id}/log`
- `DELETE /api/sessions/{id}`
- `POST /api/folders` — body `{name, parent}`
- `POST /api/clone` — body `{url, dir?}`
- `POST /api/contributors` — body `{repo, user, permission}`
