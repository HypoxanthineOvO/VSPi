import { afterEach, describe, expect, it, vi } from "vitest";
import type { Klient, OAuthFlowSnapshot } from "@moonshot-ai/klient";

import { AuthSetupApp, configureDefaultModel, loginProvider, runAuthSetup } from "../src/v1/app/auth-setup.js";
import { loginWithOAuth } from "../src/v1/providers/oauth-login.js";
import { configureProxy, ensureProviderProxy } from '../src/v1/providers/proxy-setup.js';
import { TuiMainScreen } from "@moonshot-ai/pi-tui";
import { VirtualTerminal } from "../../../packages/pi-tui/test/virtual-terminal.js";
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
  it('verifies a gateway over HTTP before atomically saving providers, models and default', async () => {
    const { createServer } = await import('node:http');
    const { saveProviderGateway } = await import('../src/v1/providers/provider-management.js');
    let authorized = false;
    const server = createServer((request, response) => {
      expect(request.url).toBe('/v1/models');
      expect(request.headers.authorization).toBe('Bearer YOUR_API_KEY');
      response.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'example-model' }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('node:net').AddressInfo;
    const sections: Record<string, unknown> = { providers: {}, models: {} };
    const replaceSections = vi.fn(async ({ sections: next }: { sections: Record<string, unknown> }) => { Object.assign(sections, next); });
    const klient = { global: { config: { inspect: async (key: string) => ({ userValue: sections[key] }), get: async (key: string) => sections[key], replaceSections } } } as unknown as Klient;
    const value = { name: 'Example Gateway', baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol: 'openai' as const, apiKey: 'YOUR_API_KEY' };
    try {
      await expect(saveProviderGateway(klient, value)).rejects.toThrow('HTTP 401');
      expect(replaceSections).not.toHaveBeenCalled();
      authorized = true;
      await saveProviderGateway(klient, value);
      expect(replaceSections).toHaveBeenCalledOnce();
      const providerId = Object.keys(sections.providers as object)[0];
      expect(sections.defaultModel).toBe(`${providerId}/example-model`);
      expect(sections.models).toMatchObject({ [`${providerId}/example-model`]: { provider: providerId, model: 'example-model', protocol: 'openai' } });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('isolates search input from letter actions and exits search with Escape', async () => {
    const { ProviderManagerController } = await import('../src/v1/ui/provider-manager.js');
    const manager = new ProviderManagerController();
    manager.setProviders([{ id: 'example', label: 'Example', protocol: 'openai', status: '已配置', detail: '', storedCredential: 'api_key' }]);
    manager.handleInput('/');
    for (const letter of ['l', 't', 'e', 'd']) expect(manager.handleInput(letter)).toBeUndefined();
    expect(manager.state.query).toBe('lted');
    manager.handleInput('\u001b');
    expect(manager.state.searching).toBe(false);
    manager.handleInput('\u001b');
    expect(manager.state.query).toBe('');
    expect(manager.handleInput('t')).toMatchObject({ type: 'test', provider: { id: 'example' } });
    manager.handleInput('d');
    expect(manager.handleInput('\r')).toMatchObject({ type: 'remove', provider: { id: 'example' } });
  });

  it('selects the custom row, preserves the busy form and retains values after save failure', async () => {
    const { ProviderManagerController } = await import('../src/v1/ui/provider-manager.js');
    const manager = new ProviderManagerController();
    manager.setProviders([{ id: 'example', label: 'Example', protocol: 'openai', status: '已配置', detail: '' }]);
    manager.handleInput('\u001b[B'); manager.handleInput('\r');
    manager.handleInput('Example Gateway'); manager.handleInput('\t'); manager.handleInput('https://gateway.example.test/v1');
    manager.handleInput('\t'); manager.handleInput('\u001b[C'); manager.handleInput('\t'); manager.handleInput('YOUR_API_KEY');
    expect(manager.handleInput('\u0013')).toMatchObject({ type: 'save', value: { name: 'Example Gateway', protocol: 'openai_responses' } });
    const theme = createTheme(detectTerminalCapabilities(), 'Terminal');
    const text = () => stripAnsi(manager.render(76, 24, theme).join('\n'));
    expect(text()).toContain('正在测试并保存');
    expect(manager.handleInput('\u0013')).toBeUndefined();
    manager.handleInput('\u001b');
    expect(text()).toContain('Example Gateway');
    manager.finishSave('HTTP 401');
    expect(text()).toContain('HTTP 401'); expect(text()).toContain('Example Gateway');
    expect(text()).not.toContain('YOUR_API_KEY');
    expect(manager.handleInput('\u0013')).toMatchObject({ type: 'save', value: { apiKey: 'YOUR_API_KEY' } });
  });

  it('keeps check results process-local, uses the real default and scrolls model details', async () => {
    const { ProviderManagerController } = await import('../src/v1/ui/provider-manager.js');
    const manager = new ProviderManagerController();
    const provider = { id: 'example', label: 'Example', protocol: 'openai', status: '已配置' as const, detail: '', defaultModel: 'example/model-8', models: Array.from({ length: 25 }, (_, index) => `example/model-${index}`) };
    manager.setProviders([provider]); manager.recordCheck('example', '离线检查：配置完整');
    manager.handleInput('\t'); for (let i = 0; i < 8; i++) manager.handleInput('\u001b[B');
    expect(manager.state.modelOffset).toBe(8);
    manager.setProviders([provider]);
    const theme = createTheme(detectTerminalCapabilities(), 'Terminal');
    const text = stripAnsi(manager.render(116, 28, theme).join('\n'));
    expect(text).toContain('example/model-8'); expect(text).toContain('离线检查');
    const fresh = new ProviderManagerController(); fresh.setProviders([provider]);
    expect(stripAnsi(fresh.render(116, 28, theme).join('\n'))).toContain('尚未测试');
  });

  it('does not replace an existing credential when API key verification fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    const replace = vi.fn();
    const current = { type: 'anthropic', apiKey: 'EXAMPLE_OLD_KEY', baseUrl: 'https://api.example.test/v1' };
    const klient = { global: { config: { get: async () => ({ url: '' }), inspect: async () => ({ userValue: { anthropic: current } }), replace }, kosong: { listBuiltinProviders: async () => [] } } } as unknown as Klient;
    await expect(loginProvider(klient, 'anthropic', 'api_key', { prompt: async () => 'EXAMPLE_NEW_KEY', notify: vi.fn() })).rejects.toThrow('HTTP 401');
    expect(replace).not.toHaveBeenCalled(); expect(current.apiKey).toBe('EXAMPLE_OLD_KEY');
  });

  it.each([76, 116])('renders the shared provider manager within %s columns', async width => {
    const { renderProviderManager } = await import('../src/v1/ui/provider-manager.js');
    const theme = createTheme(detectTerminalCapabilities(), 'Terminal');
    const rows = renderProviderManager([{ id: 'example', label: 'Example', protocol: 'openai_responses', status: '已配置', detail: '2 个模型', storedCredential: 'api_key', models: ['Model A', 'Model B'] }],
      { selected: 0, query: '', searching: false, detail: false, modelFocus: false, modelOffset: 0 }, width, 20, theme);
    expect(rows.length).toBeLessThanOrEqual(20);
    expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
    const text = stripAnsi(rows.join('\n'));
    expect(text).toContain('已连接');
    expect(text).toContain('Example  ✓ 可用');
    expect(text.includes('Endpoint')).toBe(width >= 96);
    expect(text).not.toContain('来源');
  });

  it('keeps gateway fields on validation failure and never renders its secret', async () => {
    const { ProviderGatewayForm } = await import('../src/v1/ui/provider-manager.js');
    const submit = vi.fn();
    const cancel = vi.fn();
    const form = new ProviderGatewayForm(submit, cancel);
    form.handleInput('Example Gateway'); form.handleInput('\t');
    form.handleInput('ftp://example.test'); form.handleInput('\u0013');
    expect(submit).not.toHaveBeenCalled();
    const theme = createTheme(detectTerminalCapabilities(), 'Terminal');
    expect(stripAnsi(form.render(76, theme).join('\n'))).toContain('Example Gateway');
    form.handleInput('\u0015'); form.handleInput('https://example.test/v1');
    form.handleInput('\t'); form.handleInput('\u001b[C'); form.handleInput('\t');
    form.handleInput('YOUR_API_KEY');
    expect(stripAnsi(form.render(76, theme).join('\n'))).not.toContain('YOUR_API_KEY');
    form.handleInput('\u0013');
    expect(submit).toHaveBeenCalledWith({ name: 'Example Gateway', baseUrl: 'https://example.test/v1', protocol: 'openai_responses', apiKey: 'YOUR_API_KEY' });
    form.handleInput('\u001b'); expect(cancel).toHaveBeenCalledOnce();
  });
	it('defaults SSH login to device code and explains that no localhost callback is needed', async () => {
		vi.stubEnv('SSH_CONNECTION', '192.0.2.1 12345 192.0.2.2 22');
		try {
			const dialog = new AuthDialog('OpenAI OAuth', vi.fn(), vi.fn());
			const answer = dialog.prompt({ type: 'select', message: 'Login method', options: [
				{ id: 'browser', label: 'Browser login' },
				{ id: 'device_code', label: 'Device code login' },
			] });
			dialog.handleInput('\r');
			await expect(answer).resolves.toBe('device_code');
			dialog.notify({ type: 'device_code', verificationUri: 'https://example.com/device', userCode: 'EXAMPLE' });
			const rendered = stripAnsi(dialog.render(80, createTheme(detectTerminalCapabilities(), 'Terminal')).join('\n'));
			expect(rendered).toContain('EXAMPLE');
			expect(rendered).toContain('不需要 localhost 回调');
		} finally {
			vi.unstubAllEnvs();
		}
	});
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
		const klient = { global: { config: { set, get: async () => undefined }, auth: { startLogin, listLocalCredentials: async () => [] } } } as unknown as Klient;
		const prompt = vi.fn().mockResolvedValueOnce(input);
		await loginProvider(klient, 'openai-codex', 'oauth', { prompt, notify: vi.fn() });
		expect(prompt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'text', message: '请输入代理地址', skip: { label: '跳过', value: '' } }));
		expect(startLogin).toHaveBeenCalledWith('openai-codex', { source: 'browser' });
	});

	it.each(['0', '65536', '7890; command', 'http://example.test:0', 'socks5://example.test:1080', 'https://user:password@example.test:3128', 'example.test/path', 'example.test?key=value', 'example.test#fragment'])('rejects invalid OAuth proxy %s before any login or config write', async input => {
		const set = vi.fn();
		const startLogin = vi.fn();
		const klient = { global: { config: { set, get: async () => undefined }, auth: { startLogin, listLocalCredentials: async () => [] } } } as unknown as Klient;
		await expect(loginProvider(klient, 'openai-codex', 'oauth', {
			prompt: vi.fn().mockResolvedValueOnce(input), notify: vi.fn(),
		})).rejects.toThrow('代理地址');
		expect(set).not.toHaveBeenCalled();
		expect(startLogin).not.toHaveBeenCalled();
	});

	it('lets invalid proxy input be corrected in place before saving', async () => {
		const set = vi.fn(async () => {});
		const startLogin = vi.fn(async () => ({ status: 'authenticated' }));
		const klient = { global: { config: { set, get: async () => undefined }, auth: { startLogin, listLocalCredentials: async () => [] } } } as unknown as Klient;
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
		const klient = { global: { config: { set, get: async () => undefined }, auth: { startLogin, listLocalCredentials: async () => [] } } } as unknown as Klient;
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
		const klient = { global: { config: { set, get: async () => undefined }, auth: { startLogin, listLocalCredentials: async () => [] } } } as unknown as Klient;
		const dialog = new AuthDialog('OpenAI OAuth', vi.fn(), vi.fn());
		const login = configureProxy(klient, dialog);
		dialog.handleInput('proxy.example.com:7890');
		if (mode === 'button') { dialog.handleInput('\t'); dialog.handleInput('\t'); dialog.handleInput('\r'); }
		else dialog.handleInput(mode === 'escape' ? '\u001B' : '\u0003');
		await expect(login).rejects.toThrow('cancelled');
		expect(set).not.toHaveBeenCalled();
		expect(startLogin).not.toHaveBeenCalled();
	});

	it.each([24, 80])('shows the proxy input and all three actions within %s columns', async width => {
		const dialog = new AuthDialog('OpenAI OAuth', vi.fn(), vi.fn());
		const klient = { global: { config: { get: async () => undefined } } } as unknown as Klient;
		const login = configureProxy(klient, dialog);
		const theme = createTheme(detectTerminalCapabilities(), 'Terminal');
		// 当前代理值是异步回读的提示行，先等它出现再断言整帧。
		await vi.waitFor(() => {
			expect(stripAnsi(dialog.render(width, theme).join('\n'))).toContain('当前代理');
		});
		const lines = dialog.render(width, theme);
		const rendered = stripAnsi(lines.join('\n'));
		expect(rendered).toContain('未设置');
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
		const connection = { klient: { global: { config: { set, get: async () => undefined }, auth: { startLogin, listLocalCredentials: async () => [] } } } } as unknown as RuntimeConnection;
		const backend = new KlientChatBackend(connection, '/project', 'new');
		await backend.loginProvider('anthropic', 'oauth', { prompt: async () => 'proxy.example.com:3128', notify: vi.fn() });
		expect(set).toHaveBeenCalledWith({ domain: 'proxy', patch: { url: 'http://proxy.example.com:3128' } });
		expect(startLogin).toHaveBeenCalledWith('anthropic', { source: 'browser' });
	});

	it('configures the shared proxy before requesting a Gemini API key', async () => {
		let configured = false;
		const configureBuiltinProvider = vi.fn(async () => {});
		vi.stubGlobal('fetch', vi.fn(async () => Response.json({ models: [{ name: 'models/example' }] })));
		const klient = { global: { config: { get: async () => undefined, set: async () => { configured = true; }, inspect: async () => ({ userValue: {} }) }, kosong: { configureBuiltinProvider, listBuiltinProviders: async () => [{ id: 'google', type: 'google-genai', base_url: 'https://generativelanguage.googleapis.com/v1beta' }] } } } as unknown as Klient;
		await loginProvider(klient, 'google', 'api_key', { notify: vi.fn(), prompt: async prompt => {
			if (prompt.type === 'secret') { expect(configured).toBe(true); return 'YOUR_API_KEY'; }
			return 'proxy.example.com:3128';
		} });
		expect(configureBuiltinProvider).toHaveBeenCalledWith('google', 'YOUR_API_KEY');
	});

  it.each(['dialog', 'backend'])('replaces an environment credential with an inline key through %s', async entry => {
    const replace = vi.fn(async () => {});
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'example' }] })));
    const klient = { global: { config: {
      get: async () => ({ url: '' }),
      inspect: async () => ({ userValue: { anthropic: { type: 'anthropic', apiKeyEnv: 'EXAMPLE_API_KEY' } } }),
      replace,
    }, kosong: { listBuiltinProviders: async () => [{ id: 'anthropic', type: 'anthropic', base_url: 'https://api.anthropic.com' }] } } } as unknown as Klient;
    const interaction = { prompt: async () => 'YOUR_API_KEY', notify: vi.fn() };
    if (entry === 'dialog') await loginProvider(klient, 'anthropic', 'api_key', interaction);
    else await new KlientChatBackend({ klient } as RuntimeConnection, '/project', 'new').loginProvider('anthropic', 'api_key', interaction);
    expect(replace).toHaveBeenCalledWith({ domain: 'providers', value: { anthropic: { type: 'anthropic', apiKey: 'YOUR_API_KEY', apiKeyEnv: undefined, oauth: undefined, source: undefined } } });
  });

  it.each([true, false])('lists and removes an environment credential in logout setup when its value is present=%s', async hasApiKey => {
    vi.stubEnv('EXAMPLE_API_KEY', 'YOUR_API_KEY');
    const replace = vi.fn(async () => {});
    const logout = vi.fn(async () => {});
    const config = { anthropic: { type: 'anthropic', apiKeyEnv: 'EXAMPLE_API_KEY', baseUrl: 'https://api.example.test' } };
    const klient = { global: {
      config: { get: async () => undefined, inspect: async () => ({ userValue: config }), replace },
      kosong: {
        listProviders: async () => [{ id: 'anthropic', type: 'anthropic', has_api_key: hasApiKey, status: hasApiKey ? 'connected' : 'unconfigured', models: [] }],
        listModels: async () => [], listBuiltinProviders: async () => [],
      },
      auth: { listLocalCredentials: async () => [], listLoginProviders: async () => [{ id: 'anthropic' }], logout },
    } } as unknown as Klient;
    const finish = vi.fn();
    const app = new AuthSetupApp(new TuiMainScreen(new VirtualTerminal(80, 24)), createTheme(detectTerminalCapabilities(), 'Terminal'), klient, 'logout', finish, true);
    try {
      await app.load();
      const menu = stripAnsi(app.render(80).join('\n'));
      expect(menu).toContain('Anthropic');
      expect(menu).toContain('API Key');
      expect(menu).not.toContain('订阅账号');
      await app.startInitial('anthropic');
      expect(replace).toHaveBeenCalledWith({ domain: 'providers', value: { anthropic: { type: 'anthropic', baseUrl: 'https://api.example.test', apiKey: undefined, apiKeyEnv: undefined } } });
      expect(logout).not.toHaveBeenCalled();
      expect(finish).toHaveBeenCalledOnce();
      expect(process.env.EXAMPLE_API_KEY).toBe('YOUR_API_KEY');
    } finally { vi.unstubAllEnvs(); }
  });

	it('offers Devin as an account-only provider', async () => {
		const klient = { global: {
			config: { get: async () => undefined, inspect: async () => ({ userValue: {} }) },
			kosong: {
				listProviders: async () => [],
				listModels: async () => [], listBuiltinProviders: async () => [{ id: 'devin', type: 'devin', has_api_key: false, status: 'unconfigured', models: [] }],
			},
			auth: { listLocalCredentials: async () => [], listLoginProviders: async () => [{ id: 'devin', name: 'Devin' }] },
		} } as unknown as Klient;
		const app = new AuthSetupApp(new TuiMainScreen(new VirtualTerminal(80, 24)), createTheme(detectTerminalCapabilities(), 'Terminal'), klient, 'login', vi.fn(), true);
		await app.load();
		const menu = stripAnsi(app.render(80).join('\n'));
		expect(menu).toContain('Devin');
		expect(menu).toContain('L登录');
		expect(menu).not.toContain('API Key');
		const backend = new KlientChatBackend({ klient } as RuntimeConnection, '/project', 'new');
		const options = await backend.getProviderOptions();
		expect(options.find((option) => option.id === 'devin')?.authMethods?.map((method) => method.type)).toEqual(['oauth']);
	});

	it('groups configured and addable providers by section with readable names', async () => {
		const klient = { global: {
			config: { get: async () => undefined, inspect: async () => ({ userValue: { anthropic: { type: 'anthropic', apiKey: 'YOUR_API_KEY' } } }) },
			kosong: {
				listProviders: async () => [
					{ id: 'anthropic', type: 'anthropic', has_api_key: true, status: 'connected', models: [] },
					{ id: 'deepseek', type: 'deepseek', has_api_key: false, status: 'unconfigured', models: [] },
					{ id: 'managed:internal', type: 'managed', has_api_key: false, status: 'unconfigured', models: [] },
				],
				listModels: async () => [], listBuiltinProviders: async () => [],
			},
			auth: { listLocalCredentials: async () => [], listLoginProviders: async () => [] },
		} } as unknown as Klient;
		const app = new AuthSetupApp(new TuiMainScreen(new VirtualTerminal(80, 24)), createTheme(detectTerminalCapabilities(), 'Terminal'), klient, 'config', vi.fn(), true);
		await app.load();
		const menu = stripAnsi(app.render(80).join('\n'));
		expect(menu).toContain('已连接');
		expect(menu).toContain('可添加');
		expect(menu).toContain('Anthropic');
		expect(menu).toContain('DeepSeek');
		expect(menu).toContain('添加自定义中转站');
		expect(menu).not.toContain('managed:internal');
		app.handleInput('/');
		app.handleInput('deep');
		expect(stripAnsi(app.render(80).join('\n'))).toContain('DeepSeek');
		expect(stripAnsi(app.render(80).join('\n'))).not.toContain('Anthropic');
	});

	it('moves selection in displayed order, not raw provider order', async () => {
		const klient = { global: {
			config: { get: async () => undefined, inspect: async () => ({ userValue: { zeta: { type: 'openai', apiKey: 'YOUR_API_KEY' } } }) },
			kosong: {
				listProviders: async () => [
					{ id: 'alpha', type: 'openai', has_api_key: false, status: 'unconfigured', models: [] },
					{ id: 'beta', type: 'openai', has_api_key: false, status: 'unconfigured', models: [] },
					{ id: 'zeta', type: 'openai', has_api_key: true, status: 'connected', models: [] },
				],
				listModels: async () => [], listBuiltinProviders: async () => [],
			},
			auth: { listLocalCredentials: async () => [], listLoginProviders: async () => [] },
		} } as unknown as Klient;
		const app = new AuthSetupApp(new TuiMainScreen(new VirtualTerminal(80, 24)), createTheme(detectTerminalCapabilities(), 'Terminal'), klient, 'config', vi.fn(), true);
		await app.load();
		const focusedLine = () => app.render(80).map(stripAnsi).find((line) => line.includes('›'))?.trim();
		// Zeta 在原始列表末尾但有凭据，展示为 已配置 首行并成为初始焦点。
		expect(focusedLine()).toContain('ZETA');
		// Down 移到展示顺序的第二行（可添加 分区第一行），而不是原始列表里的下一条。
		app.handleInput('\u001B[B');
		expect(focusedLine()).toContain('Alpha');
	});

  it('offers logout for a configured environment reference even when that variable is unset', async () => {
    const klient = { global: {
      config: { get: async () => undefined, inspect: async () => ({ userValue: { anthropic: { type: 'anthropic', apiKeyEnv: 'EXAMPLE_API_KEY' } } }) },
      kosong: { listProviders: async () => [{ id: 'anthropic', type: 'anthropic', has_api_key: false, status: 'unconfigured', models: [] }], listModels: async () => [], listBuiltinProviders: async () => [] },
      auth: { listLocalCredentials: async () => [], listLoginProviders: async () => [{ id: 'anthropic' }] },
    } } as unknown as Klient;
    const backend = new KlientChatBackend({ klient } as RuntimeConnection, '/project', 'new');
    expect(await backend.getProviderOptions()).toEqual([expect.objectContaining({ id: 'anthropic', storedCredential: 'api_key' })]);
  });

  it('clears environment credential configuration when logging out from the backend', async () => {
    const replace = vi.fn(async () => {});
    const klient = { global: { config: {
      inspect: async () => ({ userValue: { anthropic: { type: 'anthropic', apiKeyEnv: 'EXAMPLE_API_KEY' } } }),
      replace,
    } } } as unknown as Klient;
    await new KlientChatBackend({ klient } as RuntimeConnection, '/project', 'new').logoutProvider('anthropic');
    expect(replace).toHaveBeenCalledWith({ domain: 'providers', value: { anthropic: { type: 'anthropic', apiKey: undefined, apiKeyEnv: undefined } } });
  });

	it.each(['kimi', 'vsplab', 'deepseek'])('does not ask the domestic provider %s for this proxy', async provider => {
		const prompt = vi.fn();
		const get = vi.fn();
		const klient = { global: { config: { get }, kosong: { listProviders: async () => [{ id: provider, type: provider }] } } } as unknown as Klient;
		await ensureProviderProxy(klient, provider, { prompt, notify: vi.fn() });
		expect(prompt).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
	});

	it.each([
		{ id: 'deepseek', type: 'openai' },
		{ id: 'xiaomi', type: 'openai' },
		{ id: 'custom-gateway-abc123', type: 'openai', base_url: 'http://127.0.0.1:4117/v1' },
	])('does not ask the openai-protocol provider $id for the shared proxy', async ({ id, type, base_url }) => {
		const prompt = vi.fn();
		const get = vi.fn();
		const klient = { global: { config: { get }, kosong: { listProviders: async () => [{ id, type, base_url }] } } } as unknown as Klient;
		await ensureProviderProxy(klient, id, { prompt, notify: vi.fn() });
		expect(prompt).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
	});

	it('asks a provider outside the builtin list when its base URL is an official host', async () => {
		const set = vi.fn(async () => {});
		const prompt = vi.fn(async () => 'proxy.example.com:7890');
		const klient = {
			global: {
				config: { set, get: async () => undefined },
				kosong: { listProviders: async () => [{ id: 'claude', type: 'anthropic', base_url: 'https://api.anthropic.com' }] },
			},
		} as unknown as Klient;
		await ensureProviderProxy(klient, 'claude', { prompt, notify: vi.fn() });
		expect(prompt).toHaveBeenCalledOnce();
		expect(set).toHaveBeenCalledWith({ domain: 'proxy', patch: { url: 'http://proxy.example.com:7890' } });
	});
	afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
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

	it("atomically saves Core model and effort choices while preserving remembered efforts", async () => {
		const replaceSections = vi.fn();
		const modelEfforts = { 'other/model': 'low' };
		const klient = {
			global: { kosong: { listModels: async () => [{
				provider: "example", model: "example/model", display_name: "Example Model",
				thinking: { availability: "dynamic", can_disable: true, controls: ["effort"], efforts: ["low", "high"], default_effort: "high" },
				support_efforts: ["low", "high"], default_effort: "high",
			}], listProviders: async () => [{ id: "example", type: "example" }] }, config: { inspect: async () => ({ userValue: { modelEfforts } }), replaceSections } },
		} as unknown as Klient;
		const prompt = vi.fn().mockResolvedValueOnce("example/model").mockResolvedValueOnce("high");
		await configureDefaultModel(klient, "example", { prompt, notify: vi.fn() });
		expect(prompt.mock.calls[1]?.[0].options).toEqual([{ id: 'low', label: 'Low · 快速响应，适合简单任务' }, { id: 'high', label: 'High · 深入推理，适合复杂任务' }]);
		expect(replaceSections).toHaveBeenCalledExactlyOnceWith({ sections: { defaultModel: 'example/model', thinking: { enabled: true, effort: 'high', modelEfforts: { ...modelEfforts, 'example/model': 'high' } } } });
	});
});
