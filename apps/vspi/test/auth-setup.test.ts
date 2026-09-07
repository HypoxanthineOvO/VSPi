import { afterEach, describe, expect, it, vi } from "vitest";
import type { Klient, OAuthFlowSnapshot } from "@moonshot-ai/klient";

import { configureDefaultModel, runAuthSetup } from "../src/v1/app/auth-setup.js";
import { loginWithOAuth } from "../src/v1/providers/oauth-login.js";
import { AuthDialog } from "../src/v1/ui/auth-dialog.js";
import { createTheme } from "../src/v1/ui/theme.js";
import { detectTerminalCapabilities } from "../src/v1/ui/capabilities.js";
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
	afterEach(() => vi.useRealTimers());
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

	function oauthFixture() {
		const snapshot: OAuthFlowSnapshot = {
			flow_id: "example-flow", provider: "anthropic", status: "pending",
			verification_uri: "", verification_uri_complete: "", user_code: "",
			expires_in: 900, expires_at: new Date(Date.now() + 900_000).toISOString(), interval: 1,
			auth_url: "https://example.com/authorize",
			prompt: { id: "example-prompt", message: "Authorization code" },
		};
		const auth = {
			startLogin: vi.fn(async () => ({ ...snapshot, status: "pending" as const })),
			flow: vi.fn(async () => ({ ...snapshot })),
			submitLogin: vi.fn(async () => { snapshot.status = "authenticated"; }),
			cancelLogin: vi.fn(async () => ({ cancelled: true, status: "cancelled" as const })),
		};
		return { auth, snapshot };
	}

	it("submits OAuth prompts while polling and never renders a fake device code", async () => {
		vi.useFakeTimers();
		const { auth } = oauthFixture();
		const notify = vi.fn();
		const prompt = vi.fn(async () => "example-code");
		const login = loginWithOAuth(auth as unknown as Klient["global"]["auth"], "anthropic", { notify, prompt });
		await vi.advanceTimersByTimeAsync(2_000);
		await login;
		expect(auth.submitLogin).toHaveBeenCalledWith("anthropic", "example-flow", "example-prompt", "example-code");
		expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ type: "secret" }));
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: "auth_url" }));
		expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ type: "device_code" }));
		expect(auth.cancelLogin).not.toHaveBeenCalled();
	});

	it("finishes when the browser callback succeeds while manual input is still pending", async () => {
		vi.useFakeTimers();
		const { auth, snapshot } = oauthFixture();
		let promptSignal: AbortSignal | undefined;
		const login = loginWithOAuth(auth as unknown as Klient["global"]["auth"], "anthropic", {
			notify: vi.fn(),
			prompt: (request) => {
				promptSignal = request.signal;
				return new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		snapshot.status = "authenticated";
		await vi.advanceTimersByTimeAsync(1_000);
		await login;
		expect(promptSignal?.aborted).toBe(true);
		expect(auth.submitLogin).not.toHaveBeenCalled();
	});

	it("cancels the server flow when the user aborts a pending login", async () => {
		vi.useFakeTimers();
		const { auth } = oauthFixture();
		const controller = new AbortController();
		const login = loginWithOAuth(auth as unknown as Klient["global"]["auth"], "anthropic", {
			signal: controller.signal, notify: vi.fn(), prompt: () => new Promise(() => {}),
		});
		const rejected = expect(login).rejects.toThrow("Login cancelled");
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await rejected;
		expect(auth.cancelLogin).toHaveBeenCalledWith("anthropic");
	});

	it("supports device-code flows and cancels on transport errors", async () => {
		const { auth, snapshot } = oauthFixture();
		snapshot.auth_url = undefined;
		snapshot.prompt = undefined;
		snapshot.user_code = "EXAMPLE";
		snapshot.verification_uri_complete = "https://example.com/device";
		auth.flow.mockRejectedValueOnce(new Error("IPC closed"));
		const notify = vi.fn();
		await expect(loginWithOAuth(auth as unknown as Klient["global"]["auth"], "anthropic", { notify, prompt: vi.fn() })).rejects.toThrow("IPC closed");
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: "device_code", userCode: "EXAMPLE" }));
		expect(auth.cancelLogin).toHaveBeenCalledOnce();
	});

	it("accepts empty text when the provider supports a default domain", async () => {
		const dialog = new AuthDialog("Example", vi.fn(), vi.fn());
		const answer = dialog.prompt({ type: "text", message: "Domain", allowEmpty: true });
		dialog.handleInput("\r");
		await expect(answer).resolves.toBe("");
	});

	it("keeps large model selectors within a terminal viewport", async () => {
		const dialog = new AuthDialog("Example", vi.fn(), vi.fn());
		const answer = dialog.prompt({
			type: "select", message: "Model",
			options: Array.from({ length: 100 }, (_value, index) => ({ id: `model-${index}`, label: `Model ${index}` })),
		});
		for (let index = 0; index < 90; index++) dialog.handleInput("\u001B[B");
		const rendered = dialog.render(60, createTheme(detectTerminalCapabilities(), "Terminal"));
		expect(rendered.length).toBeLessThanOrEqual(process.stdout.rows ?? 24);
		expect(rendered.join("\n")).toContain("Model 90");
		dialog.handleInput("\r");
		await expect(answer).resolves.toBe("model-90");
	});

	it("uses Core model and effort choices when completing configuration", async () => {
		const setDefaultModel = vi.fn();
		const set = vi.fn();
		const klient = {
			global: { kosong: { listModels: async () => [{
				provider: "example", model: "example/model", display_name: "Example Model",
				thinking: { availability: "always", can_disable: false, controls: ["effort"], efforts: ["low", "high"], default_effort: "high" },
				support_efforts: ["low", "high"], default_effort: "high",
			}], listProviders: async () => [{ id: "example", type: "example" }], setDefaultModel }, config: { set } },
		} as unknown as Klient;
		const prompt = vi.fn().mockResolvedValueOnce("example/model").mockResolvedValueOnce("high");
		await configureDefaultModel(klient, "example", { prompt, notify: vi.fn() });
		expect(prompt.mock.calls[1]?.[0].options).toEqual([{ id: "high", label: "high" }, { id: "low", label: "low" }]);
		expect(setDefaultModel).toHaveBeenCalledWith("example/model");
		expect(set).toHaveBeenCalledWith({ domain: "thinking", patch: { enabled: true, effort: "high" } });
	});
});
