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
import subprocess
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

COPILOT_HOME = Path(os.environ.get("COPILOT_HOME", str(Path.home() / ".copilot")))

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


def _parse_github_repo(remote_url: str) -> str:
    """Extract owner/repo from a GitHub remote URL."""
    s = (remote_url or "").strip()
    if not s:
        return ""
    if s.endswith(".git"):
        s = s[:-4]
    s = s.rstrip("/")
    marker = "github.com/"
    if marker in s:
        tail = s.split(marker, 1)[1]
    elif "github.com:" in s:
        tail = s.split("github.com:", 1)[1]
    else:
        return ""
    parts = [p for p in tail.split("/") if p]
    if len(parts) < 2:
        return ""
    return f"{parts[0]}/{parts[1]}"


def _git_repo_for_path(path: Path) -> str:
    """Return owner/repo for a path inside a git repo with GitHub origin."""
    try:
        top = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "--show-toplevel"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
    except OSError:
        return ""
    if top.returncode != 0:
        return ""
    repo_root = top.stdout.strip()
    if not repo_root:
        return ""
    try:
        origin = subprocess.run(
            ["git", "-C", repo_root, "config", "--get", "remote.origin.url"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
    except OSError:
        return ""
    if origin.returncode != 0:
        return ""
    return _parse_github_repo(origin.stdout)


async def read_json(request: web.Request) -> dict[str, Any]:
    try:
        return await request.json()
    except Exception:
        raise web.HTTPBadRequest(reason="Invalid JSON body")


# ---------- copilot history (~/.copilot parsing) ----------

def _parse_workspace_yaml(path: Path) -> dict[str, str]:
    """Parse the flat `key: value` YAML files Copilot writes."""
    out: dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for raw in f:
                line = raw.rstrip("\n")
                if not line or line.startswith("#") or ":" not in line:
                    continue
                key, _, val = line.partition(":")
                out[key.strip()] = val.strip()
    except OSError:
        pass
    return out


def _iso_to_ts(s: str) -> float | None:
    if not s:
        return None
    try:
        from datetime import datetime
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def _history_base() -> Path:
    return COPILOT_HOME / "session-state"


def _history_entry(d: Path) -> dict[str, Any] | None:
    wy = d / "workspace.yaml"
    if not wy.is_file():
        return None
    meta = _parse_workspace_yaml(wy)
    if not meta:
        return None
    events = d / "events.jsonl"
    return {
        "id": meta.get("id") or d.name,
        "cwd": meta.get("cwd", ""),
        "summary": meta.get("summary", ""),
        "repository": meta.get("repository", ""),
        "branch": meta.get("branch", ""),
        "host_type": meta.get("host_type", ""),
        "created_at": _iso_to_ts(meta.get("created_at", "")),
        "updated_at": _iso_to_ts(meta.get("updated_at", "")),
        "has_events": events.is_file(),
        "size": events.stat().st_size if events.is_file() else 0,
    }


def _list_history(limit: int | None = None) -> list[dict[str, Any]]:
    base = _history_base()
    if not base.is_dir():
        return []
    items: list[dict[str, Any]] = []
    try:
        subs = list(base.iterdir())
    except OSError:
        return []
    for d in subs:
        if not d.is_dir():
            continue
        entry = _history_entry(d)
        if entry:
            items.append(entry)
    items.sort(key=lambda s: s.get("updated_at") or s.get("created_at") or 0, reverse=True)
    if limit:
        items = items[:limit]
    return items


def _match_copilot_session(abs_cwd: str) -> dict[str, str] | None:
    """Find the most-recently-updated Copilot session whose cwd matches."""
    if not abs_cwd:
        return None
    target = str(Path(abs_cwd)).rstrip("/")
    base = _history_base()
    if not base.is_dir():
        return None
    best: dict[str, str] | None = None
    best_ts = -1.0
    try:
        subs = list(base.iterdir())
    except OSError:
        return None
    for d in subs:
        if not d.is_dir():
            continue
        meta = _parse_workspace_yaml(d / "workspace.yaml")
        if not meta:
            continue
        if meta.get("cwd", "").rstrip("/") != target:
            continue
        ts = _iso_to_ts(meta.get("updated_at", "")) or _iso_to_ts(meta.get("created_at", "")) or 0
        if ts > best_ts:
            best_ts = ts
            best = meta
    return best


def _extract_messages(events_path: Path, max_messages: int = 200) -> list[dict[str, Any]]:
    """Pull user/assistant turns out of events.jsonl, stripped of internal wrappers."""
    messages: list[dict[str, Any]] = []
    if not events_path.is_file():
        return messages
    try:
        with open(events_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                etype = ev.get("type")
                data = ev.get("data") or {}
                if etype == "user.message":
                    c = str(data.get("content", "")).strip()
                    if c:
                        messages.append({"role": "user", "content": c, "ts": ev.get("timestamp")})
                elif etype == "assistant.message":
                    c = str(data.get("content", "")).strip()
                    if c:
                        messages.append({"role": "assistant", "content": c, "ts": ev.get("timestamp")})
                if len(messages) >= max_messages:
                    break
    except OSError:
        pass
    return messages


# ---------- session manager (PTY-based) ----------

def set_winsize(fd: int, rows: int, cols: int):
    winsize = struct.pack("HHHH", max(1, rows), max(1, cols), 0, 0)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass


def _proc_start_time(pid: int) -> float | None:
    """Wall-clock start time of a Linux process, or None if unavailable."""
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            raw = f.read().decode("utf-8", errors="replace")
        # format: "pid (comm) state ppid ..." — comm may contain spaces/parens,
        # so anchor on the final ')'.
        rest = raw[raw.rfind(")") + 2:].split()
        starttime_ticks = int(rest[19])  # field 22, 0-indexed after comm split
        clk_tck = os.sysconf("SC_CLK_TCK")
        with open("/proc/uptime") as f:
            uptime = float(f.read().split()[0])
        return (time.time() - uptime) + starttime_ticks / clk_tck
    except (OSError, ValueError, IndexError):
        return None


class Session:
    def __init__(self, path: Path, yolo: bool, remote: bool, cmd: list[str]):
        self.id = uuid.uuid4().hex
        self.path = path
        self.yolo = yolo
        self.remote = remote
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
            "remote": self.remote,
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

    def discover_external(self) -> list[dict[str, Any]]:
        """Scan /proc for copilot processes this app didn't spawn.

        Adopted sessions are returned as dicts with id="ext-<pid>" and
        adopted=True. They can be listed and stopped but not attached
        to via the WebSocket (we don't own their PTY).
        """
        if not os.path.isdir("/proc"):
            return []
        known_pids = {s.pid for s in self.sessions.values() if s.pid}
        known_pids.add(os.getpid())  # never adopt ourselves
        copilot_base = os.path.basename(COPILOT_BIN)
        results: list[dict[str, Any]] = []
        try:
            entries = os.listdir("/proc")
        except OSError:
            return results
        for ent in entries:
            if not ent.isdigit():
                continue
            pid = int(ent)
            if pid in known_pids:
                continue
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    parts = [a.decode("utf-8", errors="replace") for a in f.read().split(b"\x00") if a]
            except (OSError, FileNotFoundError):
                continue
            if not parts:
                continue
            # The copilot CLI is often a script, so argv[0] may be the
            # interpreter (node, python, bash). Accept a match anywhere in
            # the first few argv entries.
            if not any(os.path.basename(p) == copilot_base for p in parts[:3]):
                continue
            try:
                cwd = os.readlink(f"/proc/{pid}/cwd")
            except OSError:
                cwd = ""
            rel_or_abs = cwd
            try:
                if cwd:
                    rel = Path(cwd).resolve().relative_to(WORKSPACE)
                    s = str(rel)
                    rel_or_abs = "" if s == "." else s
            except ValueError:
                pass  # outside workspace; keep absolute cwd
            except OSError:
                pass
            started_at = _proc_start_time(pid) or time.time()
            results.append({
                "id": f"ext-{pid}",
                "path": rel_or_abs,
                "yolo": "--yolo" in parts,
                "remote": "--remote" in parts,
                "cmd": parts,
                "started_at": started_at,
                "ended_at": None,
                "exit_code": None,
                "pid": pid,
                "running": True,
                "output_bytes": 0,
                "attached": 0,
                "adopted": True,
            })
        return results

    async def start(self, path: Path, yolo: bool, remote: bool = True, rows: int = 30, cols: int = 100, resume: str | None = None) -> Session:
        if not path.is_dir():
            raise web.HTTPBadRequest(reason="Path is not a directory")
        cmd = [COPILOT_BIN]
        if remote:
            cmd.append("--remote")
        if yolo:
            cmd.append("--yolo")
        if resume:
            cmd.extend(["--resume", resume])
        session = Session(path=path, yolo=yolo, remote=remote, cmd=cmd)

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
    current_repo = _git_repo_for_path(target)
    return web.json_response({
        "path": rel_from_workspace(target),
        "parent": parent,
        "current_repo": current_repo,
        "entries": entries,
    })


@routes.get("/api/sessions")
async def sessions_list(request: web.Request):
    # Prefer the newest (and running) session for any given pid.
    managed_sorted = sorted(
        manager.list(),
        key=lambda s: (1 if s.running else 0, s.started_at),
        reverse=True,
    )
    managed: list[dict[str, Any]] = []
    seen_mgr_pids: set[int] = set()
    seen_mgr_pgids: set[int] = set()
    for s in managed_sorted:
        if s.pid and s.pid in seen_mgr_pids:
            continue
        if s.pid:
            seen_mgr_pids.add(s.pid)
            try:
                seen_mgr_pgids.add(os.getpgid(s.pid))
            except OSError:
                pass
        d = dict(s.to_dict(), adopted=False)
        d["abs_cwd"] = str(s.path)
        managed.append(d)
    adopted = manager.discover_external()
    adopted_filtered: list[dict[str, Any]] = []
    for a in adopted:
        pid = a.get("pid")
        if not pid or pid in seen_mgr_pids:
            continue
        try:
            if os.getpgid(int(pid)) in seen_mgr_pgids:
                continue
        except OSError:
            pass
        adopted_filtered.append(a)
    merged = managed + adopted_filtered
    # Attach the matching Copilot session id / summary when available.
    for entry in merged:
        abs_cwd = entry.get("abs_cwd") or ""
        if not abs_cwd and entry.get("adopted"):
            try:
                abs_cwd = os.readlink(f"/proc/{entry['pid']}/cwd")
            except OSError:
                abs_cwd = ""
        meta = _match_copilot_session(abs_cwd)
        if meta:
            entry["copilot_id"] = meta.get("id", "")
            entry["copilot_summary"] = meta.get("summary", "")
            entry["copilot_repository"] = meta.get("repository", "")
            entry["copilot_branch"] = meta.get("branch", "")
        entry.pop("abs_cwd", None)

    # Final dedupe: prefer copilot_id when present because a single Copilot
    # session can surface through multiple process rows/PIDs.
    merged.sort(
        key=lambda s: (
            1 if not s.get("adopted") else 0,  # keep managed (PTY-owned) first
            1 if s.get("running") else 0,
            s.get("started_at") or 0,
        ),
        reverse=True,
    )
    deduped: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for entry in merged:
        copilot_id = str(entry.get("copilot_id") or "").strip()
        if copilot_id:
            key = f"copilot:{copilot_id}"
        elif entry.get("pid"):
            key = f"pid:{entry['pid']}"
        else:
            key = f"id:{entry.get('id')}"
        if key in seen_keys:
            continue
        seen_keys.add(key)
        deduped.append(entry)
    return web.json_response({"sessions": deduped})


@routes.get("/api/history")
async def history_list(request: web.Request):
    try:
        limit = int(request.query.get("limit", "50"))
    except ValueError:
        limit = 50
    return web.json_response({"sessions": _list_history(limit=limit)})


@routes.get("/api/history/{sid}")
async def history_get(request: web.Request):
    sid = request.match_info["sid"]
    if "/" in sid or ".." in sid or not sid:
        raise web.HTTPBadRequest(reason="Invalid id")
    d = _history_base() / sid
    if not d.is_dir():
        raise web.HTTPNotFound(reason="Unknown session")
    entry = _history_entry(d)
    if not entry:
        raise web.HTTPNotFound(reason="No workspace.yaml")
    entry["messages"] = _extract_messages(d / "events.jsonl")
    return web.json_response(entry)


@routes.post("/api/sessions/start")
async def sessions_start(request: web.Request):
    data = await read_json(request)
    yolo = bool(data.get("yolo"))
    remote = bool(data.get("remote", True))
    cols = int(data.get("cols") or 100)
    rows = int(data.get("rows") or 30)
    resume_id = (data.get("resume") or "").strip()
    if resume_id:
        if "/" in resume_id or ".." in resume_id:
            raise web.HTTPBadRequest(reason="Invalid resume id")
        entry_dir = _history_base() / resume_id
        meta = _parse_workspace_yaml(entry_dir / "workspace.yaml") if entry_dir.is_dir() else {}
        cwd = meta.get("cwd", "")
        if not cwd:
            raise web.HTTPNotFound(reason="Unknown session to resume")
        target = Path(cwd)
        if not target.is_dir():
            raise web.HTTPBadRequest(reason=f"Resume cwd missing: {cwd}")
    else:
        rel = (data.get("path") or "").strip()
        target = resolve_workspace_path(rel)
    session = await manager.start(target, yolo, remote=remote, rows=rows, cols=cols, resume=resume_id or None)
    return web.json_response(session.to_dict())


def _kill_pgid(pid: int, sig: int) -> bool:
    try:
        os.killpg(os.getpgid(pid), sig)
        return True
    except (ProcessLookupError, PermissionError):
        return False


@routes.post("/api/sessions/{sid}/stop")
async def sessions_stop(request: web.Request):
    sid = request.match_info["sid"]
    if sid.startswith("ext-"):
        try:
            pid = int(sid[4:])
        except ValueError:
            raise web.HTTPBadRequest(reason="Invalid adopted session id")
        _kill_pgid(pid, signal.SIGTERM)
        for _ in range(20):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            await asyncio.sleep(0.1)
        else:
            _kill_pgid(pid, signal.SIGKILL)
        return web.json_response({"ok": True, "id": sid, "adopted": True, "running": False, "deleted": True})
    await manager.delete(sid)
    return web.json_response({"ok": True, "id": sid, "deleted": True})


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
    if sid.startswith("ext-"):
        # Nothing to forget: adopted sessions are only ever reported live
        # from /proc. If the process is gone, it disappears on next list.
        return web.json_response({"ok": True, "adopted": True})
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
    rel_parent = (data.get("path") or "").strip()
    parent = resolve_workspace_path(rel_parent)
    if not parent.is_dir():
        raise web.HTTPBadRequest(reason="Target parent is not a directory")
    if not url:
        raise web.HTTPBadRequest(reason="Missing url")
    if not dir_name:
        base = url.rstrip("/").rsplit("/", 1)[-1]
        if base.endswith(".git"):
            base = base[:-4]
        dir_name = base
    if any(ch in dir_name for ch in ("/", "\\", "..")):
        raise web.HTTPBadRequest(reason="Invalid dir name")
    target = (parent / dir_name).resolve()
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
    rel_path = (data.get("path") or "").strip()
    user = (data.get("user") or "").strip()
    perm = (data.get("permission") or "push").strip()
    if not repo:
        target = resolve_workspace_path(rel_path)
        if not target.is_dir():
            raise web.HTTPBadRequest(reason="Current path is not a directory")
        repo = _git_repo_for_path(target)
    if not repo or "/" not in repo or not user:
        raise web.HTTPBadRequest(reason="Current folder is not a git repo with a GitHub origin")
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
