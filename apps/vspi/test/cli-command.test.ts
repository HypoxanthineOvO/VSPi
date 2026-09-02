import { describe, expect, it, vi } from "vitest";

import { dispatchCliCommand } from "../src/cli-command.js";


describe("VSPi CLI command dispatch", () => {
	it("dispatches update before runtime startup and requests a restart", async () => {
		const update = vi.fn(async () => ({
			status: "updated" as const,
			currentVersion: "2.0.0",
			latestVersion: "2.1.0",
		}));
		const messages: string[] = [];
		await expect(
			dispatchCliCommand(["update"], {
				update,
				write: (message) => messages.push(message),
			}),
		).resolves.toBe(true);
		expect(update).toHaveBeenCalledWith("2.0.0");
		expect(messages.join("")).toMatch(/2\.1\.0.*重启/u);
	});

	it("reports an up-to-date install and leaves runtime commands undispatched", async () => {
		const messages: string[] = [];
		await expect(
			dispatchCliCommand(["update"], {
				update: async () => ({ status: "up-to-date", currentVersion: "2.0.0", latestVersion: "2.0.0" }),
				write: (message) => messages.push(message),
			}),
		).resolves.toBe(true);
		expect(messages.join("")).toContain("最新版本 2.0.0");
		await expect(dispatchCliCommand(["daemon"])).resolves.toBe(false);
	});

	it("rejects unsupported update arguments", async () => {
		await expect(dispatchCliCommand(["update", "extra"])).rejects.toThrow("Usage: vspi update");
	});
});
