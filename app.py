#!/usr/bin/env python3
"""Copilot Spawner server.

Serves the UI and provides endpoints to:
- Browse a workspace directory
- Spawn `copilot --remote` and `copilot --remote --yolo` sessions
- Manage sessions (list, view output, stop, delete)
- Create folders
- Clone git repositories
- Invite contributors to a GitHub repository (needs GITHUB_TOKEN)
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
import time
import traceback
import uuid
from pathlib import Path
from typing import Any

from aiohttp import web, ClientSession


HERE = Path(__file__).resolve().parent
HTML_DIR = HERE / "html"

WORKSPACE = Path(os.environ.get("COPILOT_WORKSPACE", str(HERE / "workspace"))).resolve()
WORKSPACE.mkdir(parents=True, exist_ok=True)

COPILOT_BIN = os.environ.get("COPILOT_BIN", "copilot")
HOST = os.environ.get("COPILOT_SPAWNER_HOST", "127.0.0.1")
PORT = int(os.environ.get("COPILOT_SPAWNER_PORT", "8765"))
MAX_LOG_BYTES = int(os.environ.get("COPILOT_SPAWNER_MAX_LOG", str(256 * 1024)))


# ---------- utilities ----------

def resolve_workspace_path(rel: str) -> Path:
    """Safely resolve a path relative to the workspace root. Rejects escapes."""
    rel = (rel or "").strip()
    if rel in ("", "."):
        return WORKSPACE
    candidate = (WORKSPACE / rel).resolve()
    try:
        candidate.relative_to(WORKSPACE)
    except ValueError:
        raise web.HTTPForbidden(reason="Path outside workspace")
    return candidate


def rel_from_workspace(p: Path) -> str:
    try:
        rel = p.resolve().relative_to(WORKSPACE)
        s = str(rel)
        return "" if s == "." else s
    except ValueError:
        return ""


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PB"


async def read_json(request: web.Request) -> dict[str, Any]:
    try:
        return await request.json()
    except Exception:
        raise web.HTTPBadRequest(reason="Invalid JSON body")


# ---------- session manager ----------

class Session:
    def __init__(self, path: Path, yolo: bool):
        self.id = uuid.uuid4().hex
        self.path = path
        self.yolo = yolo
        self.started_at = time.time()
        self.ended_at: float | None = None
        self.exit_code: int | None = None
        self.process: asyncio.subprocess.Process | None = None
        self.output = bytearray()
        self._reader_task: asyncio.Task | None = None

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.returncode is None

    @property
    def pid(self) -> int | None:
        return self.process.pid if self.process else None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "path": rel_from_workspace(self.path),
            "yolo": self.yolo,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "exit_code": self.exit_code,
            "pid": self.pid,
            "running": self.running,
            "output_bytes": len(self.output),
        }


class SessionManager:
    def __init__(self):
        self.sessions: dict[str, Session] = {}

    def list(self) -> list[Session]:
        return sorted(self.sessions.values(), key=lambda s: s.started_at, reverse=True)

    def get(self, sid: str) -> Session:
        s = self.sessions.get(sid)
        if not s:
            raise web.HTTPNotFound(reason="Unknown session")
        return s

    async def start(self, path: Path, yolo: bool) -> Session:
        if not path.is_dir():
            raise web.HTTPBadRequest(reason="Path is not a directory")
        cmd = [COPILOT_BIN, "--remote"]
        if yolo:
            cmd.append("--yolo")
        session = Session(path=path, yolo=yolo)
        try:
            session.process = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=str(path),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except FileNotFoundError:
            raise web.HTTPInternalServerError(
                reason=f"'{COPILOT_BIN}' not found on PATH. Set COPILOT_BIN to override."
            )
        session._reader_task = asyncio.create_task(self._read_output(session))
        self.sessions[session.id] = session
        return session

    async def _read_output(self, session: Session):
        assert session.process and session.process.stdout
        try:
            while True:
                chunk = await session.process.stdout.read(4096)
                if not chunk:
                    break
                session.output.extend(chunk)
                if len(session.output) > MAX_LOG_BYTES:
                    # keep the tail
                    overflow = len(session.output) - MAX_LOG_BYTES
                    del session.output[:overflow]
        except Exception:
            session.output.extend(
                f"\n[reader error]\n{traceback.format_exc()}\n".encode()
            )
        finally:
            rc = await session.process.wait()
            session.exit_code = rc
            session.ended_at = time.time()

    async def stop(self, sid: str) -> Session:
        session = self.get(sid)
        if session.process and session.running:
            try:
                os.killpg(os.getpgid(session.process.pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(session.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                try:
                    os.killpg(os.getpgid(session.process.pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await session.process.wait()
        return session

    async def delete(self, sid: str):
        session = self.get(sid)
        if session.running:
            await self.stop(sid)
        self.sessions.pop(sid, None)


manager = SessionManager()


# ---------- routes ----------

routes = web.RouteTableDef()


@routes.get("/")
async def index(request: web.Request):
    return web.FileResponse(HTML_DIR / "index.html")


@routes.get("/api/list")
async def list_dir(request: web.Request):
    rel = request.query.get("path", "")
    target = resolve_workspace_path(rel)
    if not target.exists() or not target.is_dir():
        raise web.HTTPNotFound(reason="Not a directory")
    entries: list[dict[str, Any]] = []
    try:
        items = sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError:
        raise web.HTTPForbidden(reason="Permission denied")
    for p in items:
        if p.name.startswith("."):
            continue
        try:
            if p.is_dir():
                entries.append({
                    "kind": "dir",
                    "name": p.name,
                    "rel": rel_from_workspace(p),
                    "is_git": (p / ".git").exists(),
                })
            else:
                size = p.stat().st_size
                entries.append({
                    "kind": "file",
                    "name": p.name,
                    "rel": rel_from_workspace(p),
                    "size": size,
                    "size_human": human_size(size),
                })
        except OSError:
            continue
    parent: str | None = None
    if target != WORKSPACE:
        parent = rel_from_workspace(target.parent)
    return web.json_response({
        "path": rel_from_workspace(target),
        "parent": parent,
        "entries": entries,
    })


@routes.get("/api/sessions")
async def sessions_list(request: web.Request):
    return web.json_response({"sessions": [s.to_dict() for s in manager.list()]})


@routes.post("/api/sessions/start")
async def sessions_start(request: web.Request):
    data = await read_json(request)
    rel = (data.get("path") or "").strip()
    yolo = bool(data.get("yolo"))
    target = resolve_workspace_path(rel)
    session = await manager.start(target, yolo)
    return web.json_response(session.to_dict())


@routes.post("/api/sessions/{sid}/stop")
async def sessions_stop(request: web.Request):
    sid = request.match_info["sid"]
    session = await manager.stop(sid)
    return web.json_response(session.to_dict())


@routes.get("/api/sessions/{sid}/log")
async def sessions_log(request: web.Request):
    sid = request.match_info["sid"]
    session = manager.get(sid)
    return web.json_response({
        "id": session.id,
        "running": session.running,
        "exit_code": session.exit_code,
        "output": session.output.decode("utf-8", errors="replace"),
    })


@routes.delete("/api/sessions/{sid}")
async def sessions_delete(request: web.Request):
    sid = request.match_info["sid"]
    await manager.delete(sid)
    return web.json_response({"ok": True})


@routes.post("/api/folders")
async def folders_create(request: web.Request):
    data = await read_json(request)
    name = (data.get("name") or "").strip()
    parent = (data.get("parent") or ".").strip() or "."
    if not name or any(ch in name for ch in ("/", "\\", "..")):
        raise web.HTTPBadRequest(reason="Invalid folder name")
    parent_path = resolve_workspace_path(parent)
    if not parent_path.is_dir():
        raise web.HTTPBadRequest(reason="Parent is not a directory")
    new_path = (parent_path / name).resolve()
    try:
        new_path.relative_to(WORKSPACE)
    except ValueError:
        raise web.HTTPForbidden(reason="Path outside workspace")
    try:
        new_path.mkdir(parents=False, exist_ok=False)
    except FileExistsError:
        raise web.HTTPConflict(reason="Folder already exists")
    except OSError as e:
        raise web.HTTPBadRequest(reason=str(e))
    return web.json_response({"path": rel_from_workspace(new_path)})


@routes.post("/api/clone")
async def clone_repo(request: web.Request):
    data = await read_json(request)
    url = (data.get("url") or "").strip()
    dir_name = (data.get("dir") or "").strip()
    if not url:
        raise web.HTTPBadRequest(reason="Missing url")
    # derive a target dir name if not supplied
    if not dir_name:
        base = url.rstrip("/").rsplit("/", 1)[-1]
        if base.endswith(".git"):
            base = base[:-4]
        dir_name = base
    if any(ch in dir_name for ch in ("/", "\\", "..")):
        raise web.HTTPBadRequest(reason="Invalid dir name")
    target = (WORKSPACE / dir_name).resolve()
    try:
        target.relative_to(WORKSPACE)
    except ValueError:
        raise web.HTTPForbidden(reason="Target outside workspace")
    if target.exists():
        raise web.HTTPConflict(reason="Target already exists")
    proc = await asyncio.create_subprocess_exec(
        "git", "clone", "--", url, str(target),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        raise web.HTTPBadRequest(reason=out.decode("utf-8", errors="replace")[:500])
    return web.json_response({
        "path": rel_from_workspace(target),
        "output": out.decode("utf-8", errors="replace"),
    })


@routes.post("/api/contributors")
async def add_contributor(request: web.Request):
    data = await read_json(request)
    repo = (data.get("repo") or "").strip()
    user = (data.get("user") or "").strip()
    perm = (data.get("permission") or "push").strip()
    if not repo or "/" not in repo or not user:
        raise web.HTTPBadRequest(reason="Provide owner/repo and user")
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        raise web.HTTPBadRequest(reason="GITHUB_TOKEN not set on server")
    url = f"https://api.github.com/repos/{repo}/collaborators/{user}"
    async with ClientSession() as http:
        async with http.put(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {token}",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            json={"permission": perm},
        ) as resp:
            body = await resp.text()
            if resp.status not in (201, 204):
                raise web.HTTPBadRequest(reason=body[:500] or f"GitHub returned {resp.status}")
            try:
                parsed = json.loads(body) if body else {}
            except json.JSONDecodeError:
                parsed = {"raw": body}
            return web.json_response({"ok": True, "status": resp.status, "data": parsed})


# ---------- middleware ----------

@web.middleware
async def error_middleware(request: web.Request, handler):
    try:
        return await handler(request)
    except web.HTTPException as e:
        if e.status >= 400:
            return web.json_response({"error": e.reason or str(e)}, status=e.status)
        raise
    except Exception:
        report = traceback.format_exc()
        sys.stderr.write(report)
        return web.json_response({"error": "Internal error"}, status=500)


# static assets
routes.static("/", str(HTML_DIR))


def main():
    app = web.Application(middlewares=[error_middleware])
    app.add_routes(routes)
    print(f"Copilot Spawner listening on http://{HOST}:{PORT}")
    print(f"Workspace: {WORKSPACE}")
    web.run_app(app, host=HOST, port=PORT, print=None)


if __name__ == "__main__":
    main()
