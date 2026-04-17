import { test, expect, Page } from "@playwright/test"

async function login(page: Page) {
	await page.goto("/login")
	await page.locator("#login-password").fill("testpw")
	await page.locator("#login-form button[type=submit]").click()
	// the server redirects to /; wait until the main screen is attached
	await page.waitForSelector("#main:not(.unloaded)", { timeout: 5_000 })
}

async function gotoScreen(page: Page, name: string) {
	await page.evaluate((n) => {
		window.location.hash = n
	}, name)
	await page.waitForSelector(`#${name}:not(.hidden)`, { timeout: 5_000 })
}

test.describe("Copilot Spawner", () => {
	test("history search UI is visible and filters the list", async ({ page }) => {
		await login(page)
		await gotoScreen(page, "history")
		const search = page.locator("#history-search")
		await expect(search).toBeVisible()
		// The search container should be visibly rendered, not zero-height
		const box = await page.locator(".search").first().boundingBox()
		expect(box).not.toBeNull()
		expect(box!.height).toBeGreaterThan(20)

		// Initially shows multiple items
		const items = page.locator("#history-list .item")
		await expect(items).toHaveCount(3)

		// Filter by a unique substring of a known summary
		await search.fill("greeting")
		await expect(items).toHaveCount(1)
		await expect(items.first()).toContainText("Acknowledge Greeting")

		// Filter by session id prefix
		await search.fill("67e1b0b0")
		await expect(items).toHaveCount(1)
		await expect(items.first()).toContainText("Enable Remote Access")

		// Clear → all items return
		await search.fill("")
		await expect(items).toHaveCount(3)
	})

	test("resume from history POSTs to /api/sessions/start with the right body", async ({ page }) => {
		await login(page)
		await gotoScreen(page, "history")
		await expect(page.locator("#history-list .item")).toHaveCount(3)

		// Capture the next POST to /api/sessions/start
		const [request] = await Promise.all([
			page.waitForRequest(
				(r) => r.url().endsWith("/api/sessions/start") && r.method() === "POST",
				{ timeout: 5_000 },
			),
			// click the first item's play (resume) button — the first action in its .actions
			page.locator("#history-list .item").first().locator(".actions i").first().click(),
		])
		const body = JSON.parse(request.postData() || "{}")
		expect(body).toMatchObject({ resume: expect.any(String), yolo: false, remote: true })
		expect(body.resume.length).toBeGreaterThan(10)
	})

	test("resume endpoint actually spawns a session (stub copilot) with --resume", async ({ page }) => {
		await login(page)
		await gotoScreen(page, "history")

		// Find the item whose cwd is our fixture workspace (only that one can actually start)
		const acknowledgeItem = page.locator("#history-list .item", { hasText: "Acknowledge Greeting" })
		await expect(acknowledgeItem).toHaveCount(1)

		const resumeBtn = acknowledgeItem.locator(".actions i").first()
		await resumeBtn.click()

		// We should land on sessions
		await expect(page.locator("#sessions")).not.toHaveClass(/hidden/)
		const session = page.locator("#sessions-list .item").first()
		await expect(session).toBeVisible({ timeout: 5_000 })

		// Sanity-check via the API that the cmd contains --resume.
		// Poll briefly since the child takes a moment to be registered.
		let found: any = null
		for (let i = 0; i < 10; i++) {
			const resp = await page.request.get("/api/sessions")
			const data = await resp.json()
			found = data.sessions.find((s: any) => s.running && Array.isArray(s.cmd) && s.cmd.includes("--resume"))
			if (found) break
			await page.waitForTimeout(200)
		}
		expect(found, "expected a running session with --resume").toBeTruthy()
		// Clean up so this session doesn't leak into other tests.
		await page.request.post(`/api/sessions/${found.id}/stop`)
	})

	test("per-folder remote toggle: click on one folder doesn't flip siblings", async ({ page }) => {
		// Two folders (demo, second) are pre-created in the fixture workspace.
		await login(page)
		await gotoScreen(page, "explorer")

		const rows = page.locator("#explorer-list .item")
		await expect(rows).toHaveCount(2)

		// Both remote icons should start "on"
		const remoteIcons = page.locator("#explorer-list .item .actions i.remote")
		await expect(remoteIcons).toHaveCount(2)
		for (let i = 0; i < 2; i++) {
			await expect(remoteIcons.nth(i)).toHaveClass(/\bon\b/)
		}

		// Click the first folder's remote icon — only it should flip off
		await remoteIcons.nth(0).click()
		await expect(remoteIcons.nth(0)).not.toHaveClass(/\bon\b/)
		await expect(remoteIcons.nth(1)).toHaveClass(/\bon\b/)

		// Starting a session on the first folder should POST remote:false
		const [req] = await Promise.all([
			page.waitForRequest((r) => r.url().endsWith("/api/sessions/start") && r.method() === "POST"),
			rows.nth(0).locator(".actions i").first().click(),
		])
		expect(JSON.parse(req.postData() || "{}")).toMatchObject({ remote: false })
	})

	test("keystrokes are not duplicated after opening/closing/reopening the terminal", async ({ page }) => {
		await login(page)
		// Start a session via the API directly so we have something to attach to
		const start = await page.request.post("/api/sessions/start", {
			data: { path: "demo", yolo: false, remote: false },
		})
		expect(start.ok()).toBeTruthy()
		const session = await start.json()
		const sid = session.id as string

		// Intercept outgoing WebSocket frames by wiring a proxy before opening,
		// and stub xterm.js (it's loaded from a CDN we cannot reach in CI).
		await page.addInitScript(() => {
			const w = window as any
			w.__wsSent = []
			const RealWS = WebSocket
			w.WebSocket = function (url: string, protocols?: any) {
				const ws = new RealWS(url, protocols)
				const origSend = ws.send.bind(ws)
				ws.send = (data: any) => {
					w.__wsSent.push(typeof data === "string" ? data : "<bin>")
					return origSend(data)
				}
				return ws
			} as any
			w.WebSocket.prototype = RealWS.prototype

			// Minimal Terminal stub covering the surface used by app.js.
			class StubTerminal {
				cols = 80
				rows = 24
				_listeners: Array<(d: string) => void> = []
				constructor(_opts: any) {}
				loadAddon(_a: any) {}
				open(_el: any) {}
				reset() {}
				write(_d: any) {}
				focus() {}
				onData(fn: (d: string) => void) {
					this._listeners.push(fn)
					const self = this
					return {
						dispose() {
							self._listeners = self._listeners.filter((l) => l !== fn)
						},
					}
				}
				paste(data: string) {
					for (const fn of this._listeners) fn(data)
				}
			}
			w.Terminal = StubTerminal
			w.FitAddon = { FitAddon: class { activate(){} dispose(){} fit(){} } }
		})
		// Reload so the init script takes effect on the main page
		await page.reload()
		await page.waitForSelector("#main:not(.unloaded)")
		await gotoScreen(page, "sessions")
		await page.waitForSelector("#sessions-list .item", { timeout: 5_000 })

		const openTermAndType = async () => {
			const termBtn = page.locator(`#sessions-list .item`).first().locator(`.actions i`).first()
			await termBtn.click()
			await page.waitForSelector("#term-modal.show")
			// Wait for xterm to mount (__term is exposed by ensureTerm).
			await page.waitForFunction(() => !!(window as any).__term, null, { timeout: 5_000 })
			// Wait for the WS to be OPEN (readyState === 1) before firing input.
			await page.waitForFunction(() => {
				// app.js keeps `termWs` module-scoped; inspect the Terminal via __wsSent
				// freshness instead — any prior handshake appends resize frames.
				const sent = (window as any).__wsSent as string[] | undefined
				return Array.isArray(sent)
			}, null, { timeout: 5_000 })
			// Trigger an onData event deterministically via paste(), which bypasses
			// keyboard/focus state but still flows through the onData handler.
			await page.evaluate(() => {
				const t = (window as any).__term
				t.paste("a")
			})
			await page.waitForTimeout(150)
			// Scope to the visible terminal modal's close button.
			await page.locator("#term-modal .panel-header i.close").click()
			await page.waitForTimeout(200)
		}

		await openTermAndType()
		await openTermAndType()
		await openTermAndType()

		// Only one plain-text "a" should be sent per open (plus JSON resize control frames)
		const sent = (await page.evaluate(() => (window as any).__wsSent)) as string[]
		const plainA = sent.filter((s) => s === "a")
		expect(plainA.length).toBe(3)

		// Clean up: stop the session
		await page.request.post(`/api/sessions/${sid}/stop`)
	})

	test("sessions list dedupes by pid", async ({ page }) => {
		await login(page)
		// Start one stub session
		const start = await page.request.post("/api/sessions/start", {
			data: { path: "demo", yolo: false, remote: false },
		})
		expect(start.ok()).toBeTruthy()
		const s1 = await start.json()

		// A pid should only appear once in the sessions list
		const resp = await page.request.get("/api/sessions")
		const data = await resp.json()
		const pids = data.sessions.map((s: any) => s.pid).filter((p: any) => p)
		expect(new Set(pids).size).toBe(pids.length)

		await page.request.post(`/api/sessions/${s1.id}/stop`)
	})
})
