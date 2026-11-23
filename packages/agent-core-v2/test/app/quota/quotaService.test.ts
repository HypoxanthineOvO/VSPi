import { afterEach, expect, it, vi } from 'vitest';
import { QuotaService } from '#/app/quota/quotaService';
import type { ProviderConfig } from '#/llm-adapter/provider/provider';
import type { ProviderQuotaConfig } from '#/app/quota/quota-contract';
import { StubConfigService, stubOAuthService } from '../../stubs';

const initial = Date.parse('2026-11-15T12:00:00Z');
const wrap = (value: unknown, status = 200) => Response.json(value, { status });
const deepseek = { type: 'deepseek', apiKey: 'synthetic-deepseek-key' };
const goodBalance = { balance_infos: [{ currency: 'CNY', total_balance: '12.25' }] };
const wallet = { mode: 'unrestricted', isValid: true, balance: 14.5, unit: 'USD' };

type Provider = ProviderConfig & { quota?: ProviderQuotaConfig; enabled?: boolean };

function setup(providers: Record<string, Provider> = { deepseek }) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(initial);
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  const oauth = stubOAuthService();
  const config = new StubConfigService({ providers });
  return { fetch, config, oauth, service: new QuotaService(config, oauth) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('coalesces all and provider-specific reads, caching fresh results for five minutes', async () => {
  const { fetch, service } = setup();
  let announce!: () => void;
  let release!: (value: Response) => void;
  const ready = new Promise<void>(resolve => { announce = resolve; });
  const response = new Promise<Response>(resolve => { release = resolve; });
  fetch.mockImplementationOnce(() => { announce(); return response; });
  const first = service.getQuotas({ providerId: 'deepseek' });
  const second = service.getQuotas();
  await ready;
  expect(fetch).toHaveBeenCalledOnce();
  release(wrap(goodBalance));
  const [a, b] = await Promise.all([first, second]);
  expect(a).toEqual(b);
  expect(a.items[0]).toMatchObject({ status: 'ok', freshUntil: initial + 300_000, staleUntil: initial + 3_600_000, balances: [{ amount: 12.25 }] });
  vi.setSystemTime(initial + 299_999);
  expect((await service.getQuotas()).revision).toBe(a.revision);
  expect(fetch).toHaveBeenCalledOnce();
  vi.setSystemTime(initial + 300_000);
  fetch.mockResolvedValueOnce(wrap(goodBalance));
  expect((await service.getQuotas()).revision).toBe(a.revision + 1);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('refresh is coalesced and the ten-second cooldown applies while returning cached rows', async () => {
  const { fetch, service } = setup();
  fetch.mockImplementation(async () => wrap(goodBalance));
  const [a, b] = await Promise.all([service.refreshQuotas(), service.refreshQuotas({ providerId: 'deepseek' })]);
  expect(fetch).toHaveBeenCalledOnce();
  expect(a).toEqual(b);
  vi.setSystemTime(initial + 1234);
  const cooled = await service.refreshQuotas();
  expect(cooled.items).toEqual(a.items);
  expect(cooled.cooldownRemainingMs).toBe(8766);
  expect(fetch).toHaveBeenCalledOnce();
  vi.setSystemTime(initial + 10_000);
  expect((await service.refreshQuotas()).cooldownRemainingMs).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('tries at most twice after a temporary failure and retires stale value after one hour', async () => {
  const { fetch, service } = setup();
  fetch.mockResolvedValueOnce(wrap(goodBalance));
  await service.getQuotas();
  fetch.mockImplementation(async () => wrap({ key: 'upstream-secret-body' }, 503));
  vi.setSystemTime(initial + 300_000);
  const stale = await service.getQuotas();
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(stale.items[0]).toMatchObject({ status: 'stale', stale: true, updatedAt: initial, checkedAt: initial + 300_000, balances: [{ amount: 12.25, stale: true }] });
  expect(JSON.stringify(stale)).not.toContain('upstream-secret-body');
  vi.setSystemTime(initial + 3_600_000);
  const expired = await service.getQuotas();
  expect(expired.items[0]).toMatchObject({ status: 'network_error', stale: false, balances: [] });
  expect(fetch).toHaveBeenCalledTimes(7);
});

it.each([[401, 'auth_expired'], [403, 'forbidden']])('HTTP %i immediately discards stale cache and never retries', async (status, reason) => {
  const { fetch, service } = setup();
  fetch.mockResolvedValueOnce(wrap(goodBalance));
  await service.getQuotas();
  fetch.mockResolvedValueOnce(wrap({ accountUrl: 'https://username:secret@example.test/' }, status));
  vi.setSystemTime(initial + 300_000);
  const denied = await service.getQuotas();
  expect(denied.items[0]).toMatchObject({ status: 'auth_error', errorReason: reason, stale: false, windows: [], balances: [] });
  expect(JSON.stringify(denied)).not.toContain('username:secret');
  expect(fetch).toHaveBeenCalledTimes(2);
  vi.setSystemTime(initial + 310_000);
  fetch.mockImplementation(async () => wrap({}, 503));
  expect((await service.getQuotas()).items[0]).toMatchObject({ status: 'network_error', stale: false, balances: [] });
});

it('does not borrow an old reading when credential configuration changes', async () => {
  const { fetch, service, config } = setup();
  fetch.mockResolvedValueOnce(wrap(goodBalance));
  await service.refreshQuotas();
  await config.replace('providers', { deepseek: { ...deepseek, apiKey: 'different-synthetic-key' } });
  fetch.mockResolvedValueOnce(wrap({}, 403));
  const changed = await service.getQuotas();
  expect(changed.items[0]).toMatchObject({ status: 'auth_error', balances: [] });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('disabled, unknown and unsafe endpoint configurations stay offline', async () => {
  const { fetch, service } = setup({
    disabled: { ...deepseek, enabled: false },
    off: { ...deepseek, quota: { mode: 'off' } },
    custom: { type: 'anthropic', apiKey: 'synthetic-key', baseUrl: 'https://relay.example.test/v1' },
    malicious: { type: 'openai', apiKey: 'synthetic-key', baseUrl: 'https://user:pass@relay.example.test/v1', quota: { mode: 'newapi-token' } },
    managed: { type: 'openai', baseUrl: 'https://relay.example.test', quota: { mode: 'newapi-account', managementKeyRef: 'vault://example' } },
  });
  const result = await service.getQuotas();
  expect(result.items.map(({ id, errorReason }) => [id, errorReason])).toEqual([
    ['off', 'disabled'], ['custom', 'unsupported'], ['malicious', 'unsupported'], ['managed', 'no_credential'],
  ]);
  expect((await service.getQuotas({ includeDisabled: true, providerId: 'disabled' })).items[0]).toMatchObject({ status: 'unconfigured', errorReason: 'disabled' });
  expect(fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('user:pass');
});

it('auto mode uses an explicitly configured management key and never borrows a generic ambient inference key', async () => {
  const { fetch, service } = setup({
    relay: { type: 'openai', baseUrl: 'https://relay.example.test/v1', quota: { managementKeyEnv: 'TEST_QUOTA_KEY' } },
    unconfigured: { type: 'openai', baseUrl: 'https://relay.example.test/v1', quota: { mode: 'newapi-token' } },
  });
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-openai-key');
  vi.stubEnv('TEST_QUOTA_KEY', 'synthetic-management-key');
  fetch.mockResolvedValueOnce(wrap({ success: true, data: { quota_per_unit: 100, quota_display_type: 'USD' } }));
  fetch.mockResolvedValueOnce(wrap({ success: true, data: { quota: 100 } }));
  const result = await service.getQuotas();
  expect(result.items).toMatchObject([{ id: 'relay', status: 'ok', balances: [{ amount: 1 }] }, { id: 'unconfigured', errorReason: 'no_credential' }]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('authorization');
  expect(fetch.mock.calls[1]?.[1]?.headers).toHaveProperty('authorization', 'Bearer synthetic-management-key');
});

it('existing VSPLab token settings select the Sub2API transport without probing other routes', async () => {
  const { fetch, service } = setup({ vsplab: { type: 'openai', apiKey: 'synthetic-vsplab' } });
  fetch.mockResolvedValueOnce(wrap(wallet));
  const result = await service.getQuotas();
  expect(result.items).toMatchObject([{ providerId: 'vsplab', category: 'balance', status: 'ok', balances: [{ amount: 14.5 }] }]);
  expect(fetch.mock.calls[0]?.[0]).toEqual(new URL('https://api.vsplab.cn/v1/usage'));
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'manual', headers: { authorization: 'Bearer synthetic-vsplab' } });
});

it('uses cached OAuth only, counts down from cached resetAt and rejects a redirect without forwarding', async () => {
  const { fetch, service, oauth } = setup({ 'openai-codex': { oauth: { storage: 'file', key: 'pi-ai/openai-codex' } } });
  const peek = vi.spyOn(oauth, 'getCachedAccessToken').mockResolvedValue('synthetic-oauth');
  const resolve = vi.spyOn(oauth, 'resolveTokenProvider');
  fetch.mockResolvedValueOnce(wrap({ rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_after_seconds: 60 } } }));
  expect((await service.getQuotas()).items[0]?.windows[0]).toMatchObject({ id: '5h', remainingPercent: 70, resetsInMs: 60_000 });
  vi.setSystemTime(initial + 3210);
  expect((await service.getQuotas()).items[0]?.windows[0]?.resetsInMs).toBe(56_790);
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://not-called.example.test' } }));
  expect((await service.refreshQuotas()).items[0]).toMatchObject({ status: 'network_error', errorReason: 'schema_mismatch', windows: [] });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(peek).toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
});

it('keeps CPA cards opaque and stable despite list order and a single upstream auth failure', async () => {
  const { fetch, service } = setup({ cpa: { quota: { mode: 'cpa', managementUrl: 'http://127.0.0.1:8317', managementKey: 'private-management-key' } } });
  const claude = { auth_index: 'private-claude-ref', provider: 'claude', label: 'https://name:pass@example.test' };
  const codex = { auth_index: 'private-codex-ref', provider: 'codex', name: 'private-codex-name' };
  let rotate = false;
  fetch.mockImplementation(async (url, init) => {
    if (url instanceof URL && url.pathname.endsWith('/credentials')) return wrap({ files: rotate ? [codex, claude] : [claude, codex] });
    if (typeof init?.body !== 'string') throw new Error('Expected a quota request body');
    const request = JSON.parse(init.body) as { auth_index: string };
    if (request.auth_index === claude.auth_index) return rotate ? wrap({ status_code: 401, body: 'private-auth-denial' })
      : wrap({ status_code: 200, body: JSON.stringify({ five_hour: { utilization: 25 } }) });
    return wrap({ status_code: 200, body: JSON.stringify({ rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 50 } } }) });
  });
  const first = await service.getQuotas();
  expect(first.items).toMatchObject([{ id: 'cpa:1', accountLabel: 'CPA · Claude #1', windows: [{ remainingPercent: 75 }] }, { id: 'cpa:2', accountLabel: 'CPA · Codex #2', windows: [{ remainingPercent: 50 }] }]);
  rotate = true;
  const refreshed = await service.refreshQuotas();
  expect(refreshed.items).toMatchObject([{ id: 'cpa:2', status: 'ok' }, { id: 'cpa:1', status: 'auth_error', stale: false, windows: [] }]);
  expect(JSON.stringify([first, refreshed])).not.toMatch(/private-|https?:|name:pass/);
  expect(fetch).toHaveBeenCalledTimes(6);
});
