window.addEventListener("load", () => {
	hashchange()
	refreshSessionsBadge()
	setInterval(refreshSessionsBadge, 3000)
})

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
	if (!localStorage.getItem("copilotspawner-light")) selectTheme(!platformIsDark(), false)
})

document.addEventListener("DOMContentLoaded", () => {
	loadBackButtons()
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
	get("main").classList.remove("unloaded")
})

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
	if (updateHash) window.location.hash = target
	let toShow = get(target)
	if (!toShow) return
	let screens = getClasses("screen")
	for (let screen of screens) {
		if (toShow == screen) screen.classList.remove("hidden")
		else screen.classList.add("hidden")
	}
	if (target == "explorer") refreshExplorer()
	if (target == "sessions") refreshSessions()
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
