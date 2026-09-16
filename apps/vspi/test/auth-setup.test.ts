import { afterEach, describe, expect, it, vi } from "vitest";
import type { Klient, OAuthFlowSnapshot } from "@moonshot-ai/klient";

import { configureDefaultModel, loginProvider, runAuthSetup } from "../src/v1/app/auth-setup.js";
import { loginWithOAuth } from "../src/v1/providers/oauth-login.js";
import { configureProxy, ensureProviderProxy } from '../src/v1/providers/proxy-setup.js';
import { AuthDialog } from "../src/v1/ui/auth-dialog.js";
import { KlientChatBackend } from '../src/v1/backend/klient-backend.js';
import type { RuntimeConnection } from '@vsp/vsp-runtime';
import { createTheme } from "../src/v1/ui/theme.js";
import { detectTerminalCapabilities } from "../src/v1/ui/capabilities.js";
import { stripAnsi, visibleWidth } from '../src/v1/ui/ansi.js';
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
	it.each([
		['7890', 'http://127.0.0.1:7890'],
		['proxy.example.com:7890', 'http://proxy.example.com:7890'],
		['192.0.2.10:3128', 'http://192.0.2.10:3128'],
		['https://proxy.example.com:8443', 'https://proxy.example.com:8443'],
		['[2001:db8::1]:7890', 'http://[2001:db8::1]:7890'],
		['proxy.example.com', 'http://proxy.example.com'],
		['', ''],
	])('saves proxy input %s before starting official OAuth', async (input, url) => {
		let saved: unknown;
		const set = vi.fn(async (value: unknown) => { saved = value; });
		const startLogin = vi.fn(async () => {
			expect(saved).toEqual({ domain: 'proxy', patch: { url } });
			return { status: 'authenticated' };
		});
		const klient = { global: { config: { set, get: async () => undefined }, auth: { startLogin } } } as unknown as Klient;
		const prompt = vi.fn().mockResolvedValueOnce(input);
		await loginProvider(klient, 'openai-codex', 'oauth', { prompt, notify: vi.fn() });
		expect(prompt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'text', message: '请输入代理地址', skip: { label: '跳过', value: '' } }));
		expect(startLogin).toHaveBeenCalledWith('openai-codex');
	});

	it.each(['0', '65536', '7890; command', 'http://example.test:0', 'socks5://example.test:1080', 'https://user:password@example.test:3128', 'example.test/path', 'example.test?key=value', 'example.test#fragment'])('rejects invalid OAuth proxy %s before any login or config write', async input => {
		const set = vi.fn();
		const startLogin = vi.fn();
		const klient = { global: { config: { set, get: async () => undefined }, auth: { startLogin } } } as unknown as Klient;
		await expect(loginProvider(klient, 'openai-codex', 'oauth', {
			prompt: vi.fn().mockResolvedValueOnce(input), notify: vi.fn(),
		})).rejects.toThrow('代理地址');
		expect(set).not.toHaveBeenCalled();
		expect(startLogin).not.toHaveBeenCalled();
	});

	it('lets invalid proxy input be corrected in place before saving', async () => {
		const set = vi.fn(async () => {});
		const startLogin = vi.fn(async () => ({ status: 'authenticated' }));
		const klient = { global: { config: { set }, auth: { startLogin } } } as unknown as Klient;
		const dialog = new AuthDialog('OpenAI OAuth', vi.fn(), vi.fn());
		const login = configureProxy(klient, dialog);
		dialog.handleInput('65536');
		dialog.handleInput('\r');
		expect(stripAnsi(dialog.render(80, createTheme(detectTerminalCapabilities(), 'Terminal')).join('\n'))).toContain('请输入有效的代理地址');
		expect(set).not.toHaveBeenCalled();
		expect(startLogin).not.toHaveBeenCalled();
		dialog.handleInput('\u0015');
		dialog.handleInput('proxy.example.com:7890');
		dialog.handleInput('\r');
		await login;
		expect(set).toHaveBeenCalledWith({ domain: 'proxy', patch: { url: 'http://proxy.example.com:7890' } });
	});

	it.each(['tab', 'down'])('skips proxy setup explicitly with %s instead of treating an empty Enter as skipping', async mode => {
		const set = vi.fn(async () => {});
		const startLogin = vi.fn(async () => ({ status: 'authenticated' }));
		const klient = { global: { config: { set }, auth: { startLogin } } } as unknown as Klient;
		const dialog = new AuthDialog('OpenAI OAuth', vi.fn(), vi.fn());
		const login = configureProxy(klient, dialog);
		dialog.handleInput('\r');
		expect(set).not.toHaveBeenCalled();
		dialog.handleInput(mode === 'tab' ? '\t' : '\u001B[B');
		dialog.handleInput('\r');
		await login;
		expect(set).toHaveBeenCalledWith({ domain: 'proxy', patch: { url: '' } });
		expect(startLogin).not.toHaveBeenCalled();
	});

	it.each(['escape', 'button', 'ctrl-c'])('cancels proxy entry with %s without saving or starting OAuth', async mode => {
		const set = vi.fn();
		const startLogin = vi.fn();
		const klient = { global: { config: { set }, auth: { startLogin } } } as unknown as Klient;
		const dialog = new AuthDialog('OpenAI OAuth', vi.fn(), vi.fn());
		const login = configureProxy(klient, dialog);
		dialog.handleInput('proxy.example.com:7890');
		if (mode === 'button') { dialog.handleInput('\t'); dialog.handleInput('\t'); dialog.handleInput('\r'); }
		else dialog.handleInput(mode === 'escape' ? '\u001B' : '\u0003');
		await expect(login).rejects.toThrow('cancelled');
		expect(set).not.toHaveBeenCalled();
		expect(startLogin).not.toHaveBeenCalled();
	});

	it.each([24, 40, 80])('shows the proxy input and all three actions within %s columns', async width => {
		const dialog = new AuthDialog('OpenAI OAuth', vi.fn(), vi.fn());
		const login = configureProxy({} as Klient, dialog);
		const lines = dialog.render(width, createTheme(detectTerminalCapabilities(), 'Terminal'));
		const rendered = stripAnsi(lines.join('\n'));
		expect(rendered).toContain('请输入代理地址');
		expect(rendered).toContain('确认');
		expect(rendered).toContain('跳过');
		expect(rendered).not.toContain('Skip');
		expect(rendered).toContain('取消');
		expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
		dialog.handleInput('65536');
		dialog.handleInput('\r');
		expect(dialog.render(width, createTheme(detectTerminalCapabilities(), 'Terminal')).length).toBeLessThanOrEqual(24);
		dialog.cancel();
		await expect(login).rejects.toThrow('cancelled');
	});

	it.each(['anthropic', 'openai-codex', 'google', 'xai'])('asks %s for a shared proxy only when no preference is saved', async provider => {
		const set = vi.fn(async () => {});
		const klient = { global: { config: { set, get: async () => undefined } } } as unknown as Klient;
		const prompt = vi.fn(async () => 'proxy.example.com:7890');
		await ensureProviderProxy(klient, provider, { prompt, notify: vi.fn() });
		expect(prompt).toHaveBeenCalledOnce();
		expect(set).toHaveBeenCalledWith({ domain: 'proxy', patch: { url: 'http://proxy.example.com:7890' } });
	});

	it.each([{ url: 'http://proxy.example.com:7890' }, { url: '' }])('does not repeat the proxy prompt for a saved preference %j', async preference => {
		const prompt = vi.fn();
		const set = vi.fn();
		const klient = { global: { config: { set, get: async (domain: string) => domain === 'proxy' ? preference : undefined } } } as unknown as Klient;
		await ensureProviderProxy(klient, 'anthropic', { prompt, notify: vi.fn() });
		expect(prompt).not.toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
	});

	it.each([0, 7890])('recognizes the released proxy port preference %s without prompting again', async openaiProxyPort => {
		const prompt = vi.fn();
		const klient = { global: { config: { get: async (domain: string) => domain === 'oauthNetwork' ? { openaiProxyPort } : undefined } } } as unknown as Klient;
		await ensureProviderProxy(klient, 'xai', { prompt, notify: vi.fn() });
		expect(prompt).not.toHaveBeenCalled();
	});

	it('uses the same proxy setup for an OAuth login inside the main TUI', async () => {
		const set = vi.fn(async () => {});
		const startLogin = vi.fn(async () => ({ status: 'authenticated' }));
		const connection = { klient: { global: { config: { set, get: async () => undefined }, auth: { startLogin } } } } as unknown as RuntimeConnection;
		const backend = new KlientChatBackend(connection, '/project', 'new');
		await backend.loginProvider('anthropic', 'oauth', { prompt: async () => 'proxy.example.com:3128', notify: vi.fn() });
		expect(set).toHaveBeenCalledWith({ domain: 'proxy', patch: { url: 'http://proxy.example.com:3128' } });
		expect(startLogin).toHaveBeenCalledWith('anthropic');
	});

	it('configures the shared proxy before requesting a Gemini API key', async () => {
		let configured = false;
		const configureBuiltinProvider = vi.fn(async () => {});
		const klient = { global: { config: { get: async () => undefined, set: async () => { configured = true; }, inspect: async () => ({ userValue: {} }) }, kosong: { configureBuiltinProvider } } } as unknown as Klient;
		await loginProvider(klient, 'google', 'api_key', { notify: vi.fn(), prompt: async prompt => {
			if (prompt.type === 'secret') { expect(configured).toBe(true); return 'YOUR_API_KEY'; }
			return 'proxy.example.com:3128';
		} });
		expect(configureBuiltinProvider).toHaveBeenCalledWith('google', 'YOUR_API_KEY');
	});

	it.each(['kimi', 'vsplab', 'deepseek'])('does not ask the domestic provider %s for this proxy', async provider => {
		const prompt = vi.fn();
		const get = vi.fn();
		const klient = { global: { config: { get }, kosong: { listProviders: async () => [{ id: provider, type: provider }] } } } as unknown as Klient;
		await ensureProviderProxy(klient, provider, { prompt, notify: vi.fn() });
		expect(prompt).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
	});
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
