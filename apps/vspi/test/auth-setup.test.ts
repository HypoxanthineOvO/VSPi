import { describe, expect, it, vi } from "vitest";

import { runAuthSetup } from "../src/v1/app/auth-setup.js";
import {
	discoverProviderModels,
	modelsFromManualInput,
} from "../src/v1/providers/custom-provider.js";

const settings = { theme: "Terminal" } as never;

function fakeConnection() {
	return {
		state: {} as never,
		env: {} as never,
		klient: {} as never,
		close: vi.fn(async () => {}),
	};
}

describe("VSPi auth setup", () => {
	it("rejects non-interactive execution before touching the runtime", async () => {
		await expect(
			runAuthSetup({
			mode: "config",
			settings,
			connection: fakeConnection(),
			stdinIsTTY: () => false,
			stdoutIsTTY: () => true,
		}),
		).rejects.toThrow("需要交互式 TTY");
	});

	it("discovers OpenAI-compatible models and preserves display names", async () => {
		const notify = vi.fn();
		const prompt = vi.fn();
		const fetcher = vi.fn(async () =>
			new Response(JSON.stringify({ data: [{ id: "model-a", name: "Model A" }, { id: "models/model-b", display_name: "Model B" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await expect(
			discoverProviderModels(
				"https://gateway.example.com/v1",
				"openai",
				"test-key",
				{ notify, prompt },
				{ fetch: fetcher },
			),
		).resolves.toEqual([
			{ id: "model-a", name: "Model A" },
			{ id: "model-b", name: "Model B" },
		]);
		expect(fetcher).toHaveBeenCalledWith(
			"https://gateway.example.com/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
			}),
		);
		expect(notify).not.toHaveBeenCalled();
	});

	it("requires at least one manual model id", () => {
		expect(() => modelsFromManualInput("  ")).toThrow("至少需要一个模型 ID");
	});
});
