window.addEventListener("load", () => {
	hashchange()
	refreshSessionsBadge({ force: true })
})

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
	if (!localStorage.getItem("copilotspawner-light")) selectTheme(!platformIsDark(), false)
})

const TAB_META = {
	main: { title: "Copilot Spawner", icon: "🤖" },
	explorer: { title: "Explorer — Copilot Spawner", icon: "📁" },
	sessions: { title: "Sessions — Copilot Spawner", icon: "💻" },
	history: { title: "History — Copilot Spawner", icon: "🕘" },
	theme: { title: "Theme — Copilot Spawner", icon: "🎨" },
}

function _tabMeta(target) {
	return TAB_META[target] || TAB_META.main
}

function _faviconSvg(icon) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="14" fill="#111827"/><text x="50%" y="52%" text-anchor="middle" dominant-baseline="middle" font-size="34">${icon}</text></svg>`
	return "data:image/svg+xml," + encodeURIComponent(svg)
}

function setTabMeta(target) {
	const meta = _tabMeta(target)
	document.title = meta.title
	let icon = get("app-favicon") || document.querySelector("link[rel='icon']")
	if (!icon) {
		icon = document.createElement("link")
		icon.id = "app-favicon"
		icon.rel = "icon"
		document.head.appendChild(icon)
	}
	icon.type = "image/svg+xml"
	icon.href = _faviconSvg(meta.icon)
}

document.addEventListener("DOMContentLoaded", () => {
	loadBackButtons()
	loadEscapeShortcut()
	loadThemePicker()
	try {
		let accent = localStorage.getItem("copilotspawner-accent")
		if (accent) selectAccent(accent, false)
		else selectAccent("lightblue", false)
		let theme = localStorage.getItem("copilotspawner-light")
		if (theme) selectTheme(theme == "true", false)
		else selectTheme(!platformIsDark(), false)
	}
	catch (e) {}
	const historySearch = get("history-search")
	if (historySearch) {
		historySearch.addEventListener("input", () => {
			if (typeof window.renderHistoryList === "function") window.renderHistoryList()
		})
	}
	const historyHideEmpty = get("history-hide-empty")
	if (historyHideEmpty) {
		try {
			const raw = localStorage.getItem("copilotspawner-history-hide-empty")
			historyHideEmpty.checked = raw == null ? true : raw === "true"
		}
		catch (e) {
			historyHideEmpty.checked = true
		}
		historyHideEmpty.addEventListener("change", () => {
			try {
				localStorage.setItem("copilotspawner-history-hide-empty", String(historyHideEmpty.checked))
			}
			catch (e) {}
			if (typeof window.renderHistoryList === "function") window.renderHistoryList()
		})
	}
	get("main").classList.remove("unloaded")
})

function loadEscapeShortcut() {
	window.addEventListener("keydown", (ev) => {
		const isEsc = ev.key === "Escape" || ev.key === "Esc" || ev.code === "Escape" || ev.keyCode === 27
		if (!isEsc || ev.repeat) return
		const termModal = get("term-modal")
		if (termModal && termModal.classList.contains("show")) {
			ev.preventDefault()
			closeTerminal()
			return
		}
		const modals = document.querySelectorAll(".modal.show")
		if (modals.length) {
			ev.preventDefault()
			const top = modals[modals.length - 1]
			if (top && top.id) closeModal(top.id)
			return
		}
		const mainScreen = get("main")
		if (mainScreen && mainScreen.classList.contains("hidden")) {
			ev.preventDefault()
			goBack()
		}
	}, true)
}

function hashchange() {
	let hash = window.location.hash.slice(1)
	if (hash == "") hash = "main"
	goto(hash, false)
}
window.addEventListener("hashchange", hashchange)

function loadBackButtons() {
	let buttons = getClasses("back")
	for (let button of buttons) {
		button.onclick = () => {
			goBack()
		}
	}
}

function goto(target, updateHash = true) {
	if (updateHash) {
		const nextHash = "#" + target
		if (window.location.hash !== nextHash) {
			window.location.hash = target
			return
		}
	}
	let toShow = get(target)
	if (!toShow) return
	let screens = getClasses("screen")
	for (let screen of screens) {
		if (toShow == screen) screen.classList.remove("hidden")
		else screen.classList.add("hidden")
	}
	setTabMeta(target)
	if (target == "main") refreshSessionsBadge({ force: true })
	if (target == "explorer") refreshExplorer()
	if (target == "sessions") refreshSessions({ force: true })
	if (target == "history") refreshHistory()
}

function goBack() {
	window.history.back()
}

function loadThemePicker() {
	let accents = getClasses("accents")[0].children
	for (let accent of accents) {
		accent.addEventListener("click", () => {
			selectAccent(accent.className)
		})
	}
	if (!localStorage.getItem("copilotspawner-light")) {
		document.querySelector("#autoDarkSwitch .checkbox").classList.add("enabled")
	}
}

function selectAccent(accent, save=true) {
	accent = accent.replace("selected", "").trim()
	let available = getClasses("accents")[0].children
	let cl = document.body.classList
	for (let color of available) {
		if (color.classList.contains(accent)) {
			color.classList.add("selected")
			cl.add(accent)
		}
		else {
			color.classList.remove("selected")
			cl.remove(color.className.replace("selected", ""))
		}
	}
	if (!save) return
	try {
		localStorage.setItem("copilotspawner-accent", accent)
	}
	catch (e) {
		console.warn("Cookies are disabled. Settings will not be saved.")
	}
}

function selectTheme(isLight, save=true) {
	let cl = document.body.classList
	let elems = getClasses("theme")
	if (isLight) cl.add("light")
	else cl.remove("light")
	elems[0 + isLight].classList.remove("selected")
	elems[1 - isLight].classList.add("selected")
	if (!save) return
	document.querySelector("#autoDarkSwitch .checkbox").classList.remove("enabled")
	try {
		localStorage.setItem("copilotspawner-light", isLight)
	}
	catch (e) {
		console.warn("Cookies are disabled. Settings will not be saved.")
	}
}

function platformIsDark() {
	return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function setAutoTheme() {
	let node = document.getElementById("autoDarkSwitch")
	let customized = localStorage.getItem("copilotspawner-light")
	let shouldBeDark = platformIsDark()
	if (customized) localStorage.removeItem("copilotspawner-light")
	else localStorage.setItem("copilotspawner-light", !shouldBeDark)
	if (customized) node.querySelector(".checkbox").classList.add("enabled")
	selectTheme(!shouldBeDark, !customized)
}
