// Copilot Spawner app logic

let currentPath = ""

async function api(path, opts = {}) {
	const resp = await fetch("/api" + path, {
		headers: { "Content-Type": "application/json" },
		...opts,
	})
	if (resp.status === 401) {
		window.location.replace("/login")
		throw new Error("Unauthenticated")
	}
	const text = await resp.text()
	let data
	try { data = JSON.parse(text) } catch { data = { error: text } }
	if (!resp.ok) throw new Error(data.error || resp.statusText)
	return data
}

function toast(message, kind = "") {
	const el = get("toast")
	el.className = "toast show " + kind
	el.innerText = message
	clearTimeout(toast._timer)
	toast._timer = setTimeout(() => el.classList.remove("show"), 3200)
}

// ---- Explorer ----

async function refreshExplorer(relPath = null) {
	if (relPath !== null) currentPath = relPath
	const listEl = get("explorer-list")
	const pathEl = get("explorer-path")
	listEl.innerHTML = ""
	pathEl.innerText = "~/" + (currentPath || "")
	try {
		const data = await api("/list?path=" + encodeURIComponent(currentPath))
		const items = []
		if (data.parent !== null && data.parent !== undefined) {
			items.push({
				kind: "up",
				name: "..",
				rel: data.parent,
			})
		}
		for (const entry of data.entries) items.push(entry)
		if (items.length === 0) {
			listEl.innerHTML = `<div class="empty"><i>folder_off</i><div>Empty folder</div></div>`
			return
		}
		for (const entry of items) {
			listEl.appendChild(renderExplorerItem(entry))
		}
	}
	catch (e) {
		listEl.innerHTML = `<div class="empty"><i>error</i><div>${escapeHtml(e.message)}</div></div>`
	}
}

function renderExplorerItem(entry) {
	const item = document.createElement("div")
	item.className = "item"
	const icon = document.createElement("i")
	const text = document.createElement("div")
	text.className = "text"
	const name = document.createElement("div")
	name.className = "name"
	name.innerText = entry.name
	const value = document.createElement("div")
	value.className = "value"
	text.appendChild(name)
	text.appendChild(value)

	if (entry.kind === "up") {
		icon.innerText = "arrow_upward"
		value.innerText = "Go up"
		item.classList.add("clickable")
		item.appendChild(icon)
		item.appendChild(text)
		const arrow = document.createElement("i")
		arrow.className = "arrow"
		item.appendChild(arrow)
		item.onclick = () => refreshExplorer(entry.rel)
		return item
	}

	if (entry.kind === "dir") {
		icon.innerText = entry.is_git ? "source" : "folder"
		value.innerText = entry.is_git ? "git repository" : "folder"
		item.classList.add("clickable")
		item.appendChild(icon)
		item.appendChild(text)

		const actions = document.createElement("div")
		actions.className = "actions"

		const startBtn = document.createElement("i")
		startBtn.innerText = "play_arrow"
		startBtn.title = "Start copilot --remote"
		startBtn.onclick = (ev) => { ev.stopPropagation(); startAgent(entry.rel, false) }
		actions.appendChild(startBtn)

		const yoloBtn = document.createElement("i")
		yoloBtn.className = "yolo"
		yoloBtn.innerText = "bolt"
		yoloBtn.title = "Start copilot --remote --yolo"
		yoloBtn.onclick = (ev) => { ev.stopPropagation(); startAgent(entry.rel, true) }
		actions.appendChild(yoloBtn)

		item.appendChild(actions)
		item.onclick = () => refreshExplorer(entry.rel)
		return item
	}

	// file
	icon.innerText = "description"
	value.innerText = entry.size_human || ""
	item.appendChild(icon)
	item.appendChild(text)
	return item
}

// ---- Sessions ----

async function startAgent(relPath, yolo) {
	try {
		const data = await api("/sessions/start", {
			method: "POST",
			body: JSON.stringify({ path: relPath, yolo }),
		})
		toast(`Started ${yolo ? "copilot --yolo" : "copilot"} on ${relPath || "~"}`, "success")
		goto("sessions")
	}
	catch (e) {
		toast(e.message, "error")
	}
}

async function refreshSessions() {
	const listEl = get("sessions-list")
	listEl.innerHTML = ""
	try {
		const data = await api("/sessions")
		if (!data.sessions.length) {
			listEl.innerHTML = `<div class="empty"><i>smart_toy</i><div>No sessions yet</div></div>`
			return
		}
		for (const s of data.sessions) listEl.appendChild(renderSessionItem(s))
	}
	catch (e) {
		listEl.innerHTML = `<div class="empty"><i>error</i><div>${escapeHtml(e.message)}</div></div>`
	}
}

function renderSessionItem(s) {
	const item = document.createElement("div")
	item.className = "item " + (s.running ? "status-running" : "status-stopped")

	const icon = document.createElement("i")
	icon.className = "leading"
	icon.innerText = s.running ? "smart_toy" : "block"

	const text = document.createElement("div")
	text.className = "text"
	const name = document.createElement("div")
	name.className = "name"
	name.innerText = s.path || "~"
	const value = document.createElement("div")
	value.className = "value"
	const stateText = s.running ? "running" : `stopped${s.exit_code != null ? ` (exit ${s.exit_code})` : ""}`
	value.innerText = `${s.yolo ? "yolo · " : ""}${stateText} · pid ${s.pid ?? "-"} · ${formatTime(s.started_at)}`
	text.appendChild(name)
	text.appendChild(value)

	const actions = document.createElement("div")
	actions.className = "actions"

	const termBtn = document.createElement("i")
	termBtn.innerText = "terminal"
	termBtn.title = s.running ? "Open terminal" : "View transcript"
	termBtn.onclick = () => openTerminal(s.id)
	actions.appendChild(termBtn)

	if (s.running) {
		const stopBtn = document.createElement("i")
		stopBtn.className = "stop"
		stopBtn.innerText = "stop"
		stopBtn.title = "Stop session"
		stopBtn.onclick = () => stopSession(s.id)
		actions.appendChild(stopBtn)
	}
	else {
		const delBtn = document.createElement("i")
		delBtn.className = "stop"
		delBtn.innerText = "delete"
		delBtn.title = "Remove"
		delBtn.onclick = () => deleteSession(s.id)
		actions.appendChild(delBtn)
	}

	item.appendChild(icon)
	item.appendChild(text)
	item.appendChild(actions)
	return item
}

async function stopSession(id) {
	try {
		await api("/sessions/" + id + "/stop", { method: "POST" })
		toast("Session stopped", "success")
		refreshSessions()
	}
	catch (e) { toast(e.message, "error") }
}

async function deleteSession(id) {
	try {
		await api("/sessions/" + id, { method: "DELETE" })
		refreshSessions()
	}
	catch (e) { toast(e.message, "error") }
}

async function refreshSessionsBadge() {
	try {
		const data = await api("/sessions")
		const running = data.sessions.filter(s => s.running).length
		const total = data.sessions.length
		const el = get("main-sessions")
		if (!el) return
		if (!total) el.innerText = "No active sessions"
		else el.innerText = `${running} running · ${total} total`
	}
	catch { /* ignore */ }
}

// ---- Terminal modal (xterm.js + WebSocket) ----

let term = null
let fitAddon = null
let termWs = null
let termResizeObs = null
let currentTermId = null

function ensureTerm() {
	if (term) return term
	const body = get("term-body")
	body.innerHTML = ""
	term = new Terminal({
		cursorBlink: true,
		fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
		fontSize: 13,
		scrollback: 5000,
		convertEol: true,
		theme: {
			background: "#0b0b0d",
			foreground: "#e6e6e6",
			cursor: "#c8e1ff",
			selectionBackground: "#3a5166",
		},
	})
	fitAddon = new FitAddon.FitAddon()
	term.loadAddon(fitAddon)
	term.open(body)
	try { fitAddon.fit() } catch {}
	termResizeObs = new ResizeObserver(() => {
		try { fitAddon.fit() } catch {}
		if (termWs && termWs.readyState === 1 && term) {
			termWs.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }))
		}
	})
	termResizeObs.observe(body)
	return term
}

async function openTerminal(id) {
	currentTermId = id
	get("term-title").innerText = "Session " + id.slice(0, 8)
	setTermStatus("connecting", "")
	get("term-modal").classList.add("show")

	ensureTerm()
	term.reset()
	try { fitAddon.fit() } catch {}

	const scheme = location.protocol === "https:" ? "wss" : "ws"
	const url = `${scheme}://${location.host}/api/sessions/${id}/ws`
	termWs = new WebSocket(url)
	termWs.binaryType = "arraybuffer"
	termWs.onopen = () => {
		setTermStatus("running", "connected")
		if (term) termWs.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }))
	}
	termWs.onmessage = (ev) => {
		if (typeof ev.data === "string") {
			try {
				const m = JSON.parse(ev.data)
				if (m.type === "exit") {
					setTermStatus("stopped", `exited (${m.code})`)
					return
				}
			} catch {}
			term.write(ev.data)
		} else {
			term.write(new Uint8Array(ev.data))
		}
	}
	termWs.onerror = () => setTermStatus("stopped", "error")
	termWs.onclose = () => setTermStatus("stopped", "disconnected")
	term.onData((d) => {
		if (termWs && termWs.readyState === 1) termWs.send(d)
	})
}

function setTermStatus(kind, text) {
	const chip = get("term-status")
	chip.className = "chip " + (kind || "")
	chip.innerText = text || kind || ""
}

function closeTerminal() {
	get("term-modal").classList.remove("show")
	if (termWs) {
		try { termWs.close() } catch {}
		termWs = null
	}
	currentTermId = null
}

// ---- Modal helpers ----

function openModal(id) {
	get(id).classList.add("show")
}

function closeModal(id) {
	get(id).classList.remove("show")
}

// ---- New folder ----

function openNewFolder() {
	get("new-folder-name").value = ""
	get("new-folder-parent").value = currentPath || "."
	openModal("new-folder-modal")
	setTimeout(() => get("new-folder-name").focus(), 50)
}

async function createFolder() {
	const name = get("new-folder-name").value.trim()
	const parent = get("new-folder-parent").value.trim() || "."
	if (!name) { toast("Enter a folder name", "error"); return }
	try {
		await api("/folders", {
			method: "POST",
			body: JSON.stringify({ name, parent }),
		})
		toast("Folder created", "success")
		closeModal("new-folder-modal")
		refreshExplorer()
	}
	catch (e) { toast(e.message, "error") }
}

// ---- Clone ----

function openClone() {
	get("clone-url").value = ""
	get("clone-dir").value = ""
	openModal("clone-modal")
	setTimeout(() => get("clone-url").focus(), 50)
}

async function cloneRepo() {
	const url = get("clone-url").value.trim()
	const dir = get("clone-dir").value.trim()
	if (!url) { toast("Enter a repository URL", "error"); return }
	try {
		toast("Cloning...", "")
		const data = await api("/clone", {
			method: "POST",
			body: JSON.stringify({ url, dir }),
		})
		toast("Cloned into " + data.path, "success")
		closeModal("clone-modal")
		refreshExplorer()
	}
	catch (e) { toast(e.message, "error") }
}

// ---- Contributors ----

function openContributors() {
	get("contrib-user").value = ""
	openModal("contributors-modal")
	setTimeout(() => {
		const repoEl = get("contrib-repo")
		if (!repoEl.value) repoEl.focus()
		else get("contrib-user").focus()
	}, 50)
}

async function addContributor() {
	const repo = get("contrib-repo").value.trim()
	const user = get("contrib-user").value.trim()
	const perm = get("contrib-perm").value
	if (!repo || !user) { toast("Repo and user are required", "error"); return }
	try {
		await api("/contributors", {
			method: "POST",
			body: JSON.stringify({ repo, user, permission: perm }),
		})
		toast(`Invited ${user} to ${repo}`, "success")
		closeModal("contributors-modal")
	}
	catch (e) { toast(e.message, "error") }
}

// ---- Auth ----

async function logout() {
	try { await fetch("/api/logout", { method: "POST" }) } catch {}
	window.location.replace("/login")
}

// ---- helpers ----

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({
		"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
	}[c]))
}

function formatTime(ts) {
	if (!ts) return ""
	const d = new Date(ts * 1000)
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}
