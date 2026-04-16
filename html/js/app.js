// Copilot Spawner app logic

let currentPath = ""

async function api(path, opts = {}) {
	const resp = await fetch("/api" + path, {
		headers: { "Content-Type": "application/json" },
		...opts,
	})
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

	const logBtn = document.createElement("i")
	logBtn.innerText = "terminal"
	logBtn.title = "View output"
	logBtn.onclick = () => openLog(s.id)
	actions.appendChild(logBtn)

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

// ---- Log modal ----

let logPollTimer = null
let currentLogId = null

async function openLog(id) {
	currentLogId = id
	get("log-title").innerText = "Session " + id.slice(0, 8)
	get("log-body").innerText = "Loading..."
	get("log-modal").classList.add("show")
	await fetchLog()
	clearInterval(logPollTimer)
	logPollTimer = setInterval(fetchLog, 1500)
}

async function fetchLog() {
	if (!currentLogId) return
	try {
		const data = await api("/sessions/" + currentLogId + "/log")
		const body = get("log-body")
		const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 20
		body.innerText = data.output || "(no output yet)"
		if (atBottom) body.scrollTop = body.scrollHeight
	}
	catch (e) {
		get("log-body").innerText = "Error: " + e.message
	}
}

function closeLog() {
	get("log-modal").classList.remove("show")
	clearInterval(logPollTimer)
	logPollTimer = null
	currentLogId = null
}

// ---- New folder ----

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
		get("new-folder-name").value = ""
		goto("explorer")
	}
	catch (e) { toast(e.message, "error") }
}

// ---- Clone ----

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
		get("clone-url").value = ""
		get("clone-dir").value = ""
		goto("explorer")
	}
	catch (e) { toast(e.message, "error") }
}

// ---- Contributors ----

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
		get("contrib-user").value = ""
	}
	catch (e) { toast(e.message, "error") }
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
