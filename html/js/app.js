// Copilot Spawner app logic

let currentPath = ""
let currentRepo = ""

// Per-key remote toggle. Keys are opaque strings (folder rel path, or
// "history:<id>" for a resume action). Missing key means "on" (the default).
const _remoteOverride = new Map()

function isRemoteFor(key) {
	return _remoteOverride.has(key) ? _remoteOverride.get(key) : false
}

function toggleRemoteFor(key, iconEl) {
	const next = !isRemoteFor(key)
	_remoteOverride.set(key, next)
	if (iconEl) {
		iconEl.classList.toggle("on", next)
		iconEl.title = `--remote is ${next ? "on" : "off"} (click to toggle)`
	}
}

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
		currentRepo = String(data?.current_repo || "")
		const contribBtn = get("explorer-contrib-action")
		if (contribBtn) contribBtn.style.display = currentRepo ? "" : "none"
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

		const key = entry.rel
		if (!_remoteOverride.has(key)) _remoteOverride.set(key, Boolean(entry.is_git))
		const isOn = isRemoteFor(key)

		const startBtn = document.createElement("i")
		startBtn.innerText = "play_arrow"
		startBtn.title = `Start copilot${isOn ? " --remote" : ""}`
		startBtn.onclick = (ev) => { ev.stopPropagation(); startAgent(entry.rel, false) }
		actions.appendChild(startBtn)

		const yoloBtn = document.createElement("i")
		yoloBtn.className = "yolo"
		yoloBtn.innerText = "bolt"
		yoloBtn.title = `Start copilot${isOn ? " --remote" : ""} --yolo`
		yoloBtn.onclick = (ev) => { ev.stopPropagation(); startAgent(entry.rel, true) }
		actions.appendChild(yoloBtn)

		const remoteBtn = document.createElement("i")
		remoteBtn.className = "remote" + (isOn ? " on" : "")
		remoteBtn.innerText = "public"
		remoteBtn.title = `--remote is ${isOn ? "on" : "off"} (click to toggle)`
		remoteBtn.onclick = (ev) => {
			ev.stopPropagation()
			toggleRemoteFor(key, remoteBtn)
			const on = isRemoteFor(key)
			startBtn.title = `Start copilot${on ? " --remote" : ""}`
			yoloBtn.title = `Start copilot${on ? " --remote" : ""} --yolo`
		}
		actions.appendChild(remoteBtn)

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

const _startingAgents = new Set()

async function startAgent(relPath, yolo) {
	const remote = isRemoteFor(relPath)
	const key = `${relPath}|${yolo ? 1 : 0}|${remote ? 1 : 0}`
	if (_startingAgents.has(key)) return
	_startingAgents.add(key)
	try {
		await api("/sessions/start", {
			method: "POST",
			body: JSON.stringify({ path: relPath, yolo, remote }),
		})
		const parts = ["copilot"]
		if (remote) parts.push("--remote")
		if (yolo) parts.push("--yolo")
		toast(`Started ${parts.join(" ")} on ${relPath || "~"}`, "success")
		goto("sessions")
	}
	catch (e) {
		toast(e.message, "error")
	}
	finally {
		_startingAgents.delete(key)
	}
}

async function resumeHistory(id, yolo) {
	const remote = isRemoteFor("history:" + id)
	const key = `resume:${id}|${yolo ? 1 : 0}|${remote ? 1 : 0}`
	if (_startingAgents.has(key)) return
	_startingAgents.add(key)
	try {
		await api("/sessions/start", {
			method: "POST",
			body: JSON.stringify({ resume: id, yolo, remote }),
		})
		const parts = ["copilot"]
		if (remote) parts.push("--remote")
		if (yolo) parts.push("--yolo")
		parts.push("--resume", id.slice(0, 8) + "…")
		toast(`Resumed ${parts.join(" ")}`, "success")
		closeModal("history-modal")
		goto("sessions")
	}
	catch (e) {
		toast(e.message, "error")
	}
	finally {
		_startingAgents.delete(key)
	}
}

let _sessionsRefreshInFlight = false
let _sessionsRefreshQueued = false
let _sessionsRefreshQueuedForce = false
let _sessionsDataInFlight = null
let _sessionsDataCache = { sessions: [], at: 0 }
let _sessionsLastSignature = ""
let _sessionsEmptyStreak = 0
let _sessionsHadData = false

function _sessionDedupKey(s) {
	if (!s || typeof s !== "object") return ""
	if (s.pid != null) return "pid:" + s.pid
	const sid = String(s.id || "").trim()
	if (sid) return "id:" + sid
	const copilotId = String(s.copilot_id || "").trim()
	if (copilotId) return "copilot:" + copilotId
	return ""
}

function _normalizeSessions(raw) {
	const items = Array.isArray(raw) ? raw : []
	const deduped = []
	const seen = new Set()
	for (const s of items) {
		const key = _sessionDedupKey(s)
		if (!key || seen.has(key)) continue
		seen.add(key)
		deduped.push(s)
	}
	return deduped
}

function _sessionsSignature(sessions) {
	return sessions
		.map((s) => [
			_sessionDedupKey(s),
			s.running ? 1 : 0,
			s.exit_code ?? "",
			s.started_at ?? "",
			s.pid ?? "",
			s.path ?? "",
			s.copilot_summary ?? "",
		].join("|"))
		.join("||")
}

async function _getSessionsData({ force = false } = {}) {
	const now = Date.now()
	if (_sessionsDataInFlight) return _sessionsDataInFlight
	if (!force && (now - _sessionsDataCache.at) < 1200) return { sessions: _sessionsDataCache.sessions }
	const run = api("/sessions").then((data) => {
		const sessions = _normalizeSessions(data?.sessions)
		_sessionsDataCache = { sessions, at: Date.now() }
		return { sessions }
	}).finally(() => {
		if (_sessionsDataInFlight === run) _sessionsDataInFlight = null
	})
	_sessionsDataInFlight = run
	return run
}

async function refreshSessions({ force = false } = {}) {
	const listEl = get("sessions-list")
	if (_sessionsRefreshInFlight) {
		_sessionsRefreshQueued = true
		_sessionsRefreshQueuedForce = _sessionsRefreshQueuedForce || force
		return
	}
	_sessionsRefreshInFlight = true
	try {
		const data = await _getSessionsData({ force })
		const sessions = data.sessions
		const signature = _sessionsSignature(sessions)
		if (!sessions.length) {
			_sessionsEmptyStreak += 1
			if (_sessionsHadData && _sessionsEmptyStreak < 2) return
			_sessionsHadData = false
			_sessionsLastSignature = ""
			listEl.innerHTML = `<div class="empty"><i>smart_toy</i><div>No sessions yet</div></div>`
			return
		}
		_sessionsEmptyStreak = 0
		_sessionsHadData = true
		if (signature === _sessionsLastSignature) return
		_sessionsLastSignature = signature
		listEl.replaceChildren(...sessions.map(renderSessionItem))
	}
	catch (e) {
		if (!_sessionsLastSignature) listEl.innerHTML = `<div class="empty"><i>error</i><div>${escapeHtml(e.message)}</div></div>`
	}
	finally {
		_sessionsRefreshInFlight = false
		if (_sessionsRefreshQueued) {
			_sessionsRefreshQueued = false
			const queuedForce = _sessionsRefreshQueuedForce
			_sessionsRefreshQueuedForce = false
			refreshSessions({ force: queuedForce })
		}
	}
}

function renderSessionItem(s) {
	const item = document.createElement("div")
	item.className = "item " + (s.running ? "status-running" : "status-stopped")

	const icon = document.createElement("i")
	icon.className = "leading"
	icon.innerText = s.adopted ? "public" : (s.running ? "smart_toy" : "block")

	const text = document.createElement("div")
	text.className = "text"
	const name = document.createElement("div")
	name.className = "name"
	const title = s.copilot_summary || s.path || "~"
	name.innerText = title
	const value = document.createElement("div")
	value.className = "value"
	const stateText = s.running ? "running" : `stopped${s.exit_code != null ? ` (exit ${s.exit_code})` : ""}`
	const flags = []
	if (s.adopted) flags.push("external")
	if (s.remote) flags.push("remote")
	if (s.yolo) flags.push("yolo")
	const bits = []
	if (s.copilot_id) bits.push(s.copilot_id.slice(0, 8))
	if (s.copilot_summary && s.path) bits.push(s.path)
	bits.push(stateText, `pid ${s.pid ?? "-"}`, formatTime(s.started_at))
	const prefix = flags.length ? flags.join(" · ") + " · " : ""
	value.innerText = prefix + bits.join(" · ")
	text.appendChild(name)
	text.appendChild(value)

	const actions = document.createElement("div")
	actions.className = "actions"

	if (!s.adopted) {
		const termBtn = document.createElement("i")
		termBtn.innerText = "terminal"
		termBtn.title = s.running ? "Open terminal" : "View transcript"
		termBtn.onclick = () => openTerminal(s.id)
		actions.appendChild(termBtn)
	}

	if (s.running) {
		const stopBtn = document.createElement("i")
		stopBtn.className = "stop"
		stopBtn.innerText = "stop"
		stopBtn.title = s.adopted ? "Stop external session (SIGTERM)" : "Stop session"
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
		toast("Session stopped and removed", "success")
		refreshSessions({ force: true })
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

async function refreshSessionsBadge({ force = false } = {}) {
	try {
		const data = await _getSessionsData({ force })
		const running = data.sessions.filter(s => s.running).length
		const total = data.sessions.length
		const el = get("main-sessions")
		if (!el) return
		if (!total) el.innerText = "No active sessions"
		else el.innerText = `${running} running · ${total} total`
	}
	catch { /* ignore */ }
}

// ---- History ----

let _historyCache = []

function isHistoryEntryEmpty(h) {
	const summary = String(h?.summary || "").trim()
	return !summary
}

function historyHideEmptyEnabled() {
	const toggle = get("history-hide-empty")
	return toggle ? toggle.checked : true
}

async function refreshHistory() {
	const listEl = get("history-list")
	listEl.innerHTML = ""
	try {
		const data = await api("/history?limit=200")
		const sessions = Array.isArray(data?.sessions) ? data.sessions : []
		_historyCache = sessions.filter((h) => h && h.id)
		renderHistoryList()
	}
	catch (e) {
		listEl.innerHTML = `<div class="empty"><i>error</i><div>${escapeHtml(e.message)}</div></div>`
	}
}

function renderHistoryList() {
	const listEl = get("history-list")
	listEl.innerHTML = ""
	const q = (get("history-search")?.value || "").trim().toLowerCase()
	const source = Array.isArray(_historyCache) ? _historyCache : []
	const hideEmpty = historyHideEmptyEnabled()
	const visibleSource = hideEmpty ? source.filter(h => !isHistoryEntryEmpty(h)) : source
	refreshHistoryBadge(visibleSource.length)
	const filtered = q
		? visibleSource.filter(h => {
			const hay = [
				h?.id ?? "",
				h?.summary ?? "",
				h?.cwd ?? "",
				h?.repository ?? "",
				h?.branch ?? "",
			].join(" ").toLowerCase()
			return hay.includes(q)
		})
		: visibleSource
	if (!filtered.length) {
		const msg = q
			? `No matches for "${escapeHtml(q)}"`
			: (hideEmpty ? "No past sessions with a summary in ~/.copilot" : "No past sessions in ~/.copilot")
		listEl.innerHTML = `<div class="empty"><i>history_toggle_off</i><div>${msg}</div></div>`
		return
	}
	for (const h of filtered) {
		if (!h || !h.id) continue
		listEl.appendChild(renderHistoryItem(h))
	}
}
window.renderHistoryList = renderHistoryList

function refreshHistoryBadge(count) {
	const el = get("main-history")
	if (!el) return
	if (count > 0) el.innerText = `${count} past session${count === 1 ? "" : "s"}`
	else el.innerText = "No past sessions"
}

function renderHistoryItem(h) {
	const sid = String(h?.id || "")
	const item = document.createElement("div")
	item.className = "item clickable"

	const icon = document.createElement("i")
	icon.innerText = h.repository ? "source" : "forum"

	const text = document.createElement("div")
	text.className = "text"
	const name = document.createElement("div")
	name.className = "name"
	name.innerText = h.summary || "(no summary)"
	const value = document.createElement("div")
	value.className = "value"
	const bits = [sid.slice(0, 8)]
	if (h.repository) bits.push(h.repository + (h.branch ? ` @ ${h.branch}` : ""))
	if (h.cwd) bits.push(h.cwd)
	if (h.updated_at) bits.push(formatDate(h.updated_at))
	value.innerText = bits.join(" · ")
	text.appendChild(name)
	text.appendChild(value)

	item.appendChild(icon)
	item.appendChild(text)
	item.appendChild(renderResumeActions(sid, Boolean(h?.repository)))
	item.onclick = () => openHistoryDetail(sid)
	return item
}

function renderResumeActions(id, defaultRemote = true) {
	const actions = document.createElement("div")
	actions.className = "actions"
	const key = "history:" + id
	if (!_remoteOverride.has(key)) _remoteOverride.set(key, defaultRemote)
	const isOn = isRemoteFor(key)

	const resumeBtn = document.createElement("i")
	resumeBtn.innerText = "play_arrow"
	resumeBtn.title = `Resume copilot${isOn ? " --remote" : ""} --resume ${id.slice(0, 8)}`
	resumeBtn.onclick = (ev) => { ev.stopPropagation(); resumeHistory(id, false) }
	actions.appendChild(resumeBtn)

	const yoloBtn = document.createElement("i")
	yoloBtn.className = "yolo"
	yoloBtn.innerText = "bolt"
	yoloBtn.title = `Resume copilot${isOn ? " --remote" : ""} --yolo --resume ${id.slice(0, 8)}`
	yoloBtn.onclick = (ev) => { ev.stopPropagation(); resumeHistory(id, true) }
	actions.appendChild(yoloBtn)

	const remoteBtn = document.createElement("i")
	remoteBtn.className = "remote" + (isOn ? " on" : "")
	remoteBtn.innerText = "public"
	remoteBtn.title = `--remote is ${isOn ? "on" : "off"} (click to toggle)`
	remoteBtn.onclick = (ev) => {
		ev.stopPropagation()
		toggleRemoteFor(key, remoteBtn)
		const on = isRemoteFor(key)
		resumeBtn.title = `Resume copilot${on ? " --remote" : ""} --resume ${id.slice(0, 8)}`
		yoloBtn.title = `Resume copilot${on ? " --remote" : ""} --yolo --resume ${id.slice(0, 8)}`
	}
	actions.appendChild(remoteBtn)
	return actions
}

async function openHistoryDetail(id) {
	get("history-title").innerText = "Session " + id.slice(0, 8)
	const body = get("history-body")
	body.innerHTML = `<div class="empty"><i>hourglass_top</i><div>Loading…</div></div>`
	openModal("history-modal")
	try {
		const d = await api("/history/" + encodeURIComponent(id))
		renderHistoryDetail(d)
	}
	catch (e) {
		body.innerHTML = `<div class="empty"><i>error</i><div>${escapeHtml(e.message)}</div></div>`
	}
}

function renderHistoryDetail(d) {
	const body = get("history-body")
	body.innerHTML = ""

	const resumeBar = document.createElement("div")
	resumeBar.className = "history-resume"
	const label = document.createElement("div")
	label.className = "history-resume-label"
	label.innerText = "Resume this session"
	resumeBar.appendChild(label)
	resumeBar.appendChild(renderResumeActions(d.id, Boolean(d.repository)))
	body.appendChild(resumeBar)

	const meta = document.createElement("div")
	meta.className = "history-meta"
	const rows = [
		["id", d.id],
		["summary", d.summary || "—"],
		["cwd", d.cwd || "—"],
		["repository", d.repository ? d.repository + (d.branch ? " @ " + d.branch : "") : "—"],
		["created", d.created_at ? formatDate(d.created_at) : "—"],
		["updated", d.updated_at ? formatDate(d.updated_at) : "—"],
	]
	for (const [k, v] of rows) {
		const row = document.createElement("div")
		row.className = "meta-row"
		row.innerHTML = `<span class="key">${escapeHtml(k)}</span><span class="val">${escapeHtml(String(v))}</span>`
		meta.appendChild(row)
	}
	body.appendChild(meta)

	const msgs = document.createElement("div")
	msgs.className = "history-messages"
	if (!d.messages || !d.messages.length) {
		msgs.innerHTML = `<div class="empty"><i>forum</i><div>No transcript recorded</div></div>`
	} else {
		for (const m of d.messages) {
			const row = document.createElement("div")
			row.className = "msg msg-" + (m.role === "user" ? "user" : "assistant")
			const who = document.createElement("div")
			who.className = "who"
			who.innerText = m.role
			const content = document.createElement("div")
			content.className = "content"
			content.innerText = m.content
			row.appendChild(who)
			row.appendChild(content)
			msgs.appendChild(row)
		}
	}
	body.appendChild(msgs)
}


// ---- Terminal modal (xterm.js + WebSocket) ----

let term = null
let fitAddon = null
let termWs = null
let termResizeObs = null
let termOnDataDisposable = null
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
	// Exposed for end-to-end tests that need to trigger input programmatically.
	window.__term = term
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

	// Dispose a previous keystroke handler before attaching a new one —
	// otherwise xterm stacks them and every keystroke gets sent N times.
	if (termOnDataDisposable) {
		try { termOnDataDisposable.dispose() } catch {}
		termOnDataDisposable = null
	}

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
	termOnDataDisposable = term.onData((d) => {
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
	if (termOnDataDisposable) {
		try { termOnDataDisposable.dispose() } catch {}
		termOnDataDisposable = null
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
	openModal("new-folder-modal")
	setTimeout(() => get("new-folder-name").focus(), 50)
}

async function createFolder() {
	const name = get("new-folder-name").value.trim()
	if (!name) { toast("Enter a folder name", "error"); return }
	try {
		await api("/folders", {
			method: "POST",
			body: JSON.stringify({ name, parent: currentPath || "." }),
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
			body: JSON.stringify({ url, dir, path: currentPath || "." }),
		})
		toast("Cloned into " + data.path, "success")
		closeModal("clone-modal")
		refreshExplorer()
	}
	catch (e) { toast(e.message, "error") }
}

// ---- Contributors ----

function openContributors() {
	if (!currentRepo) { toast("Current folder is not a git repo with GitHub origin", "error"); return }
	get("contrib-user").value = ""
	get("contrib-repo").value = currentRepo
	openModal("contributors-modal")
	setTimeout(() => {
		get("contrib-user").focus()
	}, 50)
}

async function addContributor() {
	const user = get("contrib-user").value.trim()
	const perm = get("contrib-perm").value
	if (!user) { toast("Username is required", "error"); return }
	try {
		await api("/contributors", {
			method: "POST",
			body: JSON.stringify({ path: currentPath || ".", user, permission: perm }),
		})
		toast(`Invited ${user} to ${currentRepo}`, "success")
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

function formatDate(ts) {
	if (!ts) return ""
	const d = new Date(ts * 1000)
	const now = Date.now()
	const dayMs = 24 * 3600 * 1000
	if (now - d.getTime() < dayMs) return formatTime(ts)
	if (now - d.getTime() < 7 * dayMs) {
		return d.toLocaleDateString([], { weekday: "short" }) + " " + formatTime(ts)
	}
	return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + formatTime(ts)
}
