import { defineConfig, devices } from "@playwright/test"
import { resolve } from "node:path"

const port = Number(process.env.CS_PORT ?? 18765)
const here = __dirname

export default defineConfig({
	testDir: "./e2e",
	timeout: 30_000,
	fullyParallel: false,
	reporter: "list",
	retries: 0,
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				launchOptions: {
					executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
				},
			},
		},
	],
	webServer: {
		command: `python3 ../app.py`,
		cwd: ".",
		url: `http://127.0.0.1:${port}/login`,
		reuseExistingServer: false,
		timeout: 20_000,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			COPILOT_SPAWNER_HOST: "127.0.0.1",
			COPILOT_SPAWNER_PORT: String(port),
			COPILOT_SPAWNER_PASSWORD: "testpw",
			COPILOT_SPAWNER_SECRET: "a".repeat(64),
			COPILOT_WORKSPACE: resolve(here, "fixtures/workspace"),
			COPILOT_HOME: resolve(here, "fixtures/copilot"),
			COPILOT_BIN: resolve(here, "fixtures/bin/copilot"),
		},
	},
})
