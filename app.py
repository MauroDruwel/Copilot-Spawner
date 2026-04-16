#!/usr/bin/env python3
"""Copilot Spawner server.

A small self-hosted web app that browses a workspace, spawns `copilot
--remote` (optionally with --yolo) agents per folder, and exposes each
agent through a live, interactive web terminal over WebSocket.
"""
from __future__ import annotations

import asyncio
import base64
import fcntl
import hashlib
import hmac
import json
import os
import pty
import secrets
import signal
import struct
import sys
import termios
import time
import traceback
import uuid
from pathlib import Path
from typing import Any

from aiohttp import web, ClientSession, WSMsgType


# ---------- configuration ----------

HERE = Path(__file__).resolve().parent
HTML_DIR = HERE / "html"

WORKSPACE = Path(os.environ.get("COPILOT_WORKSPACE", str(HERE / "workspace"))).resolve()
WORKSPACE.mkdir(parents=True, exist_ok=True)

COPILOT_BIN = os.environ.get("COPILOT_BIN", "copilot")
HOST = os.environ.get("COPILOT_SPAWNER_HOST", "127.0.0.1")
PORT = int(os.environ.get("COPILOT_SPAWNER_PORT", "8765"))
MAX_LOG_BYTES = int(os.environ.get("COPILOT_SPAWNER_MAX_LOG", str(512 * 1024)))

# Auth: if PASSWORD is set, login is required. Otherwise a fresh random one is
# generated on startup and printed so the operator can copy it.
_ENV_PASSWORD = os.environ.get("COPILOT_SPAWNER_PASSWORD", "").strip()
PASSWORD = _ENV_PASSWORD or secrets.token_urlsafe(16)
PASSWORD_AUTO = not _ENV_PASSWORD

# HMAC secret for signing session cookies. If not provided, a random one is
# generated per process (so restarts invalidate sessions).
SECRET = os.environ.get("COPILOT_SPAWNER_SECRET") or secrets.token_hex(32)
COOKIE_NAME = "cs_session"
SESSION_TTL = int(os.environ.get("COPILOT_SPAWNER_SESSION_TTL", str(7 * 24 * 3600)))
COOKIE_SECURE = os.environ.get("COPILOT_SPAWNER_COOKIE_SECURE", "auto").lower()

PUBLIC_PATHS = {
    "/login",
    "/login.html",
    "/api/login",
    "/api/auth/status",
}
PUBLIC_PREFIXES = ("/css/", "/js/login", "/fonts/", "/img/")


# ---------- auth helpers ----------

def _sign(payload: str) -> str:
    mac = hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")


def make_token(ttl: int = SESSION_TTL) -> str:
    expires = int(time.time()) + ttl
    payload = f"v1.{expires}"
    return f"{payload}.{_sign(payload)}"


def verify_token(token: str | None) -> bool:
    if not token:
        return False
    try:
        version, exp_s, sig = token.split(".")
    except ValueError:
        return False
    if version != "v1":
        return False
    try:
        expires = int(exp_s)
    except ValueError:
        return False
    if expires < int(time.time()):
        return False
    expected = _sign(f"{version}.{exp_s}")
    return hmac.compare_digest(sig, expected)


def is_authenticated(request: web.Request) -> bool:
    return verify_token(request.cookies.get(COOKIE_NAME))


def should_secure_cookie(request: web.Request) -> bool:
    if COOKIE_SECURE in ("1", "true", "yes", "on"):
        return True
    if COOKIE_SECURE in ("0", "false", "no", "off"):
        return False
    # auto: honor proxy header and request scheme
    xf = request.headers.get("X-Forwarded-Proto", "").lower()
    if xf == "https":
        return True
    return request.scheme == "https"


def set_session_cookie(resp: web.Response, request: web.Request):
    resp.set_cookie(
        COOKIE_NAME,
        make_token(),
        max_age=SESSION_TTL,
        httponly=True,
        samesite="Lax",
        secure=should_secure_cookie(request),
        path="/",
    )


# ---------- utilities ----------

def resolve_workspace_path(rel: str) -> Path:
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


# ---------- session manager (PTY-based) ----------

def set_winsize(fd: int, rows: int, cols: int):
    winsize = struct.pack("HHHH", max(1, rows), max(1, cols), 0, 0)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass


class Session:
    def __init__(self, path: Path, yolo: bool, cmd: list[str]):
        self.id = uuid.uuid4().hex
        self.path = path
        self.yolo = yolo
        self.cmd = cmd
        self.started_at = time.time()
        self.ended_at: float | None = None
        self.exit_code: int | None = None
        self.pid: int | None = None
        self.pty_fd: int | None = None
        self.output = bytearray()
        self.ws_peers: set[web.WebSocketResponse] = set()
        self._wait_task: asyncio.Task | None = None

    @property
    def running(self) -> bool:
        return self.pid is not None and self.exit_code is None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "path": rel_from_workspace(self.path),
            "yolo": self.yolo,
            "cmd": self.cmd,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "exit_code": self.exit_code,
            "pid": self.pid,
            "running": self.running,
            "output_bytes": len(self.output),
            "attached": len(self.ws_peers),
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

    async def start(self, path: Path, yolo: bool, rows: int = 30, cols: int = 100) -> Session:
        if not path.is_dir():
            raise web.HTTPBadRequest(reason="Path is not a directory")
        cmd = [COPILOT_BIN, "--remote"]
        if yolo:
            cmd.append("--yolo")
        session = Session(path=path, yolo=yolo, cmd=cmd)

        try:
            pid, fd = pty.fork()
        except OSError as e:
            raise web.HTTPInternalServerError(reason=f"pty.fork failed: {e}")

        if pid == 0:
            # child
            try:
                os.chdir(str(path))
                os.environ["TERM"] = os.environ.get("TERM", "xterm-256color")
                os.execvp(cmd[0], cmd)
            except FileNotFoundError:
                os.write(2, f"'{cmd[0]}' not found on PATH. Set COPILOT_BIN to override.\n".encode())
                os._exit(127)
            except Exception as e:
                os.write(2, f"exec failed: {e}\n".encode())
                os._exit(126)

        # parent
        session.pid = pid
        session.pty_fd = fd
        set_winsize(fd, rows, cols)

        loop = asyncio.get_running_loop()
        loop.add_reader(fd, self._on_pty_readable, session)
        session._wait_task = asyncio.create_task(self._wait_child(session))

        self.sessions[session.id] = session
        return session

    def _on_pty_readable(self, session: Session):
        if session.pty_fd is None:
            return
        try:
            data = os.read(session.pty_fd, 4096)
        except OSError:
            data = b""
        if not data:
            loop = asyncio.get_event_loop()
            try:
                loop.remove_reader(session.pty_fd)
            except (ValueError, KeyError):
                pass
            return
        session.output.extend(data)
        if len(session.output) > MAX_LOG_BYTES:
            overflow = len(session.output) - MAX_LOG_BYTES
            del session.output[:overflow]
        # Broadcast to peers
        for ws in list(session.ws_peers):
            if ws.closed:
                session.ws_peers.discard(ws)
                continue
            asyncio.create_task(self._send_safe(ws, data, session))

    @staticmethod
    async def _send_safe(ws: web.WebSocketResponse, data: bytes, session: Session):
        try:
            await ws.send_bytes(data)
        except Exception:
            session.ws_peers.discard(ws)

    async def _wait_child(self, session: Session):
        loop = asyncio.get_running_loop()
        # Poll for child exit; PTY reader handles output draining.
        while True:
            try:
                wpid, status = os.waitpid(session.pid, os.WNOHANG)
            except ChildProcessError:
                break
            if wpid == 0:
                await asyncio.sleep(0.4)
                continue
            session.exit_code = os.waitstatus_to_exitcode(status)
            break
        session.ended_at = time.time()
        # Drain any trailing output
        await asyncio.sleep(0.2)
        if session.pty_fd is not None:
            try:
                loop.remove_reader(session.pty_fd)
            except (ValueError, KeyError):
                pass
            try:
                os.close(session.pty_fd)
            except OSError:
                pass
            session.pty_fd = None
        # Notify peers
        for ws in list(session.ws_peers):
            try:
                await ws.send_json({"type": "exit", "code": session.exit_code})
                await ws.close()
            except Exception:
                pass
        session.ws_peers.clear()

    async def stop(self, sid: str) -> Session:
        session = self.get(sid)
        if session.pid and session.running:
            try:
                os.killpg(os.getpgid(session.pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            for _ in range(20):
                if not session.running:
                    break
                await asyncio.sleep(0.1)
            if session.running:
                try:
                    os.killpg(os.getpgid(session.pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
                for _ in range(20):
                    if not session.running:
                        break
                    await asyncio.sleep(0.1)
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
    if not is_authenticated(request):
        raise web.HTTPFound("/login")
    return web.FileResponse(HTML_DIR / "index.html")


@routes.get("/login")
async def login_page(request: web.Request):
    if is_authenticated(request):
        raise web.HTTPFound("/")
    return web.FileResponse(HTML_DIR / "login.html")


@routes.post("/api/login")
async def api_login(request: web.Request):
    data = await read_json(request)
    supplied = str(data.get("password", ""))
    # constant-time comparison
    if not hmac.compare_digest(supplied, PASSWORD):
        await asyncio.sleep(0.8)  # slow brute force a bit
        raise web.HTTPUnauthorized(reason="Invalid password")
    resp = web.json_response({"ok": True})
    set_session_cookie(resp, request)
    return resp


@routes.post("/api/logout")
async def api_logout(request: web.Request):
    resp = web.json_response({"ok": True})
    resp.del_cookie(COOKIE_NAME, path="/")
    return resp


@routes.get("/api/auth/status")
async def api_auth_status(request: web.Request):
    return web.json_response({"authenticated": is_authenticated(request)})


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
    cols = int(data.get("cols") or 100)
    rows = int(data.get("rows") or 30)
    target = resolve_workspace_path(rel)
    session = await manager.start(target, yolo, rows=rows, cols=cols)
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


@routes.get("/api/sessions/{sid}/ws")
async def sessions_ws(request: web.Request):
    if not is_authenticated(request):
        raise web.HTTPUnauthorized(reason="Unauthenticated")
    sid = request.match_info["sid"]
    session = manager.get(sid)
    ws = web.WebSocketResponse(heartbeat=25)
    await ws.prepare(request)

    # Send backlog so the client sees history
    if session.output:
        try:
            await ws.send_bytes(bytes(session.output))
        except Exception:
            await ws.close()
            return ws

    session.ws_peers.add(ws)
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                raw = msg.data
                handled = False
                if raw.startswith("{") and raw.endswith("}"):
                    try:
                        payload = json.loads(raw)
                        if payload.get("type") == "resize":
                            if session.pty_fd is not None:
                                set_winsize(
                                    session.pty_fd,
                                    int(payload.get("rows", 30)),
                                    int(payload.get("cols", 100)),
                                )
                            handled = True
                    except (ValueError, TypeError):
                        pass
                if not handled and session.pty_fd is not None:
                    try:
                        os.write(session.pty_fd, raw.encode("utf-8", errors="replace"))
                    except OSError:
                        break
            elif msg.type == WSMsgType.BINARY:
                if session.pty_fd is not None:
                    try:
                        os.write(session.pty_fd, msg.data)
                    except OSError:
                        break
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                break
    finally:
        session.ws_peers.discard(ws)
    return ws


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
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
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
async def auth_middleware(request: web.Request, handler):
    path = request.path
    if path in PUBLIC_PATHS or any(path.startswith(p) for p in PUBLIC_PREFIXES):
        return await handler(request)
    if is_authenticated(request):
        return await handler(request)
    if path.startswith("/api/"):
        return web.json_response({"error": "unauthenticated"}, status=401)
    return web.HTTPFound("/login")


@web.middleware
async def error_middleware(request: web.Request, handler):
    try:
        return await handler(request)
    except web.HTTPException as e:
        if e.status >= 400 and request.path.startswith("/api/"):
            return web.json_response({"error": e.reason or str(e)}, status=e.status)
        raise
    except Exception:
        report = traceback.format_exc()
        sys.stderr.write(report)
        if request.path.startswith("/api/"):
            return web.json_response({"error": "Internal error"}, status=500)
        return web.Response(status=500, text="Internal error")


# static assets (must be last so routes above win)
routes.static("/", str(HTML_DIR))


def _print_banner():
    lines = [
        "",
        "  \033[1;36mCopilot Spawner\033[0m",
        f"  Listening on \033[1mhttp://{HOST}:{PORT}\033[0m",
        f"  Workspace:   {WORKSPACE}",
    ]
    if PASSWORD_AUTO:
        lines += [
            "",
            "  \033[1;33mNo COPILOT_SPAWNER_PASSWORD was set.\033[0m",
            "  An ephemeral password has been generated for this process:",
            f"    \033[1;32m{PASSWORD}\033[0m",
            "  Set COPILOT_SPAWNER_PASSWORD and COPILOT_SPAWNER_SECRET to make it persistent.",
        ]
    else:
        lines.append("  Auth: password from COPILOT_SPAWNER_PASSWORD")
    lines.append("")
    print("\n".join(lines), flush=True)


def main():
    app = web.Application(middlewares=[error_middleware, auth_middleware])
    app.add_routes(routes)
    _print_banner()
    web.run_app(app, host=HOST, port=PORT, print=None)


if __name__ == "__main__":
    main()
