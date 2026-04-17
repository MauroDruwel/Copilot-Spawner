document.addEventListener("DOMContentLoaded", () => {
	applyTheme();
	const form = document.getElementById("login-form");
	form.addEventListener("submit", onSubmit);
	document.getElementById("login-password").focus();
});

function applyTheme() {
	try {
		const accent = localStorage.getItem("copilotspawner-accent") || "lightblue";
		const light = localStorage.getItem("copilotspawner-light");
		const isLight = light ? light === "true" : !window.matchMedia("(prefers-color-scheme: dark)").matches;
		document.body.className = accent + (isLight ? " light" : "");
	} catch (e) {}
}

async function onSubmit(ev) {
	ev.preventDefault();
	const err = document.getElementById("login-error");
	err.style.display = "none";
	const password = document.getElementById("login-password").value;
	try {
		const resp = await fetch("/api/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password }),
		});
		if (!resp.ok) {
			const data = await resp.json().catch(() => ({}));
			throw new Error(data.error || "Sign-in failed");
		}
		window.location.replace("/");
	} catch (e) {
		err.innerText = e.message || "Sign-in failed";
		err.style.display = "block";
	}
}
