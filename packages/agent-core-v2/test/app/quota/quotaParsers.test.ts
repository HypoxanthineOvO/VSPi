import { describe, expect, it, vi } from 'vitest';
import { QuotaError, type RequestQuota } from '#/app/quota/quota-parsers/common';
import { readCpa } from '#/app/quota/quota-parsers/cpa';
import { decodeSub2Api, readNewApi, readRelayQuota } from '#/app/quota/quota-parsers/newapi';
import { matchOfficial, readOfficial, type OfficialKind } from '#/app/quota/quota-parsers/official';

const now = Date.parse('2026-11-15T12:00:00Z');
const root = new URL('https://relay.example.test/');

const officialFixtures = [
  ['codex', 'https://chatgpt.com/backend-api/wham/usage', { rate_limit: {
    primary_window: { used_percent: 100, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 0, reset_after_seconds: 3600, limit_window_seconds: 604_800 },
  } }, { windows: [{ id: '5h', remainingPercent: 0 }, { id: '7d', remainingPercent: 100, resetAt: now + 3_600_000 }] }],
  ['claude', 'https://api.anthropic.com/api/oauth/usage', { five_hour: { utilization: 0 }, seven_day_fable: { utilization: 30 }, seven_day_opus: { utilization: 90 } },
    { windows: [{ id: '5h', remainingPercent: 100 }, { id: 'claude.7d.fable', remainingPercent: 70, modelIds: ['claude-fable-5-1'] }] }],
  ['deepseek', 'https://api.deepseek.com/user/balance', { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }, { currency: 'USD', total_balance: '-0.25' }, { currency: 'EUR', total_balance: '5.50' }] },
    { balances: [{ currency: 'CNY', amount: 0 }, { currency: 'USD', amount: -0.25 }, { currency: 'EUR', amount: 5.5 }] }],
  ['kimi', 'https://api.kimi.com/coding/v1/usages', { usages: { limit_5h: { used_ratio: '0.25' } }, boosterWallet: { balance: { type: 'BOOSTER', amountLeft: '125000000' }, monthlyUsed: { currency: 'CNY' } } },
    { windows: [{ id: '5h', remainingPercent: 75 }], balances: [{ id: 'kimi.booster', currency: 'CNY', amount: 1.25 }] }],
  ['glm', 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', { success: true, code: 200, data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 0 }] } },
    { windows: [{ id: '5h', remainingPercent: 100 }] }],
  ['minimax', 'https://api.minimax.cn/v1/token_plan/remains', { base_resp: { status_code: 0 }, model_remains: [{ model_name: 'general', current_interval_remaining_percent: 75, current_weekly_status: 3 }] },
    { windows: [{ remainingPercent: 75 }], balances: [{ unlimited: true }] }],
  ['devin', 'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus', { userStatus: { planStatus: { dailyQuotaRemainingPercent: 75, overageBalanceMicros: '2500000' } } },
    { windows: [{ id: 'daily', remainingPercent: 75 }], balances: [{ amount: 2.5, currency: 'USD' }] }],
  ['antigravity', 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', { models: { 'gemini-4-argon-medium': { quotaInfo: { remainingFraction: 0.5 } }, 'not-configured': { quotaInfo: { remainingFraction: 0.1 } } } },
    { windows: [{ modelIds: ['gemini-4-argon-medium'], remainingPercent: 50 }] }],
] as const satisfies readonly [OfficialKind, string, unknown, unknown][];

describe('read-only official quotas', () => {
  it.each(officialFixtures)('projects the %s fixture and uses its fixed endpoint', async (kind, expectedUrl, body, expected) => {
    const request = vi.fn<RequestQuota>(async () => body);
    const data = await readOfficial(request, kind, { token: 'fixture', region: 'cn', modelIds: ['claude-fable-5-1', 'gemini-4-argon-medium'], projectId: 'example-project' }, now);
    expect(data).toMatchObject(expected);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe(expectedUrl);
    if (kind === 'glm') expect(request.mock.calls[0]?.[1]?.headers?.['authorization']).toBe('fixture');
    else if (kind === 'devin') expect(request.mock.calls[0]?.[1]?.headers?.['x-api-key']).toBe('devin-session-token$fixture');
    else expect(request.mock.calls[0]?.[1]?.headers?.['authorization']).toBe('Bearer fixture');
  });

  it('ignores unknown model display labels and keeps valid Claude model-specific buckets', async () => {
    const request: RequestQuota = async () => ({ limits: [
      { kind: 'session', percent: 12 }, { kind: 'weekly_all', percent: 35 },
      { kind: 'weekly_fable', scope: { model: { display_name: 'Fable only' } }, percent: 20 },
      { kind: 'weekly_unknown', scope: { model: { display_name: 'https://test:secret@example.test/account' } }, percent: 10 },
    ] });
    const data = await readOfficial(request, 'claude', { token: 'fixture', region: 'cn', modelIds: ['claude-fable-5-1'] }, now);
    expect(data.windows).toMatchObject([{ id: '5h' }, { id: '7d' }, { label: 'Fable', remainingPercent: 80 }]);
    expect(JSON.stringify(data)).not.toContain('secret');
  });

  it('does not identify a custom relay as an official source or accept invalid quota as zero', async () => {
    expect(matchOfficial('anthropic', 'anthropic', 'https://relay.example.test/v1')).toBeUndefined();
    const request: RequestQuota = async () => ({ balance_infos: [{ currency: 'USD', total_balance: null }] });
    await expect(readOfficial(request, 'deepseek', { token: 'fixture', region: 'cn', modelIds: [] }, now)).rejects.toMatchObject({ reason: 'schema_mismatch' });
  });
});

function newApiFixture(data: unknown, metadata = { quota_per_unit: 100, quota_display_type: 'USD' }) {
  return vi.fn<RequestQuota>(async url => ({ success: true, data: String(url).endsWith('/api/status') ? metadata : data }));
}

describe('NewAPI and Sub2API', () => {
  it('queries a management-key account with user id, denomination and configured multiplier', async () => {
    const request = newApiFixture({ quota: 12000, used_quota: 300, group: 'premium', group_ratio: 0.5 });
    const data = await readNewApi(request, root, { profile: 'account', token: 'synthetic-management', userId: '42', multiplier: 0.25 });
    expect(data.balances).toMatchObject([{ id: 'account.balance', currency: 'USD', amount: 120, multiplier: 0.25, equivalentAmount: 480 }]);
    expect(request.mock.calls).toEqual([[new URL('api/status', root)], [new URL('api/user/self', root), { headers: { authorization: 'Bearer synthetic-management', 'new-api-user': '42' } }]]);
  });

  it('queries token limits, keeping granted quota and unlimited separate', async () => {
    const finite = newApiFixture({ total_available: 0, total_granted: 500, unlimited_quota: false, group_ratio: 0.5 });
    expect((await readNewApi(finite, root, { profile: 'token', token: 'synthetic-token' })).balances).toMatchObject([{ id: 'token.limit', amount: 0, limit: 5, equivalentAmount: 0 }]);
    expect(finite.mock.calls[1]?.[0]).toEqual(new URL('api/usage/token/', root));
    const unlimited = await readNewApi(newApiFixture({ total_available: 999999, unlimited_quota: true }), root, { profile: 'token', token: 'synthetic-token' });
    expect(unlimited.balances).toMatchObject([{ unlimited: true, amount: 0 }]);
  });

  it('keeps unknown display units as points and rejects malformed quotas', async () => {
    const points = await readNewApi(newApiFixture({ quota: 12000 }, { quota_per_unit: 500000, quota_display_type: 'CUSTOM' }), root, { profile: 'account', token: 'fixture' });
    expect(points.balances).toMatchObject([{ currency: 'POINTS', amount: 12000 }]);
    for (const quota of [null, undefined, '', false, ' ', '0x10', '1e3', Infinity]) {
      await expect(readNewApi(newApiFixture({ quota }), root, { profile: 'account', token: 'fixture' })).rejects.toMatchObject({ reason: 'schema_mismatch' });
    }
  });

  it('VSPLab wallet returns the actual USD balance and multiplier, not unlimited', async () => {
    const request = vi.fn<RequestQuota>(async () => ({ mode: 'unrestricted', isValid: true, planName: '钱包余额', remaining: 14.5, balance: 14.5, unit: 'USD' }));
    const data = await readRelayQuota(request, root, { profile: 'token', token: 'fixture', sub2api: true, multiplier: 0.5 });
    expect(data.balances).toMatchObject([{ id: 'account.balance', currency: 'USD', amount: 14.5, equivalentAmount: 29 }]);
    expect(data.balances[0]?.unlimited).toBeUndefined();
    expect(request.mock.calls).toEqual([[new URL('v1/usage', root), { headers: { authorization: 'Bearer fixture' } }]]);
  });

  it('VSPLab limited key keeps total balance and all window percentages separate', () => {
    const resetAt = new Date(now + 60_000).toISOString();
    const data = decodeSub2Api({ mode: 'quota_limited', isValid: true, unit: 'USD', remaining: 1.25,
      quota: { limit: 5, used: 3.75, remaining: 1.25, unit: 'USD' },
      rate_limits: [
        { window: '5h', limit: 2, used: 0.5, remaining: 1.5, reset_at: resetAt },
        { window: '1d', limit: 8, used: 4, remaining: 4 },
        { window: '7d', limit: 16, used: 16, remaining: 0 },
      ] });
    expect(data.balances).toMatchObject([{ id: 'token.limit', amount: 1.25, limit: 5 }]);
    expect(data.balances[0]?.unlimited).toBeUndefined();
    expect(data.windows).toMatchObject([{ id: '5h', remainingPercent: 75, resetAt: now + 60_000 }, { id: 'daily', remainingPercent: 50 }, { id: '7d', remainingPercent: 0 }]);
  });

  it('VSPLab finite subscriptions preserve daily, weekly and monthly windows without pretending they are wallet balances', () => {
    const { balances, windows } = decodeSub2Api({ mode: 'unrestricted', isValid: true, unit: 'USD', remaining: 1,
      subscription: { daily_limit_usd: 2, daily_usage_usd: 1, weekly_limit_usd: 4, weekly_usage_usd: 1, monthly_limit_usd: 16, monthly_usage_usd: 4 } });
    expect(balances).toMatchObject([{ id: 'subscription.allowance', amount: 1 }]);
    expect(balances[0]?.unlimited).toBeUndefined();
    expect(windows).toMatchObject([{ id: 'daily', remainingPercent: 50 }, { id: '7d', remainingPercent: 75 }, { id: 'monthly', remainingPercent: 75 }]);
  });

  it('VSPLab observed -1 subscription sentinel is explicitly unlimited', () => {
    const data = decodeSub2Api({ mode: 'unrestricted', isValid: true, unit: 'USD', remaining: -1,
      subscription: { daily_limit_usd: null, weekly_limit_usd: null, monthly_limit_usd: null } });
    expect(data.balances).toMatchObject([{ id: 'subscription.allowance', unlimited: true }]);
    expect(data.windows).toEqual([]);
  });

  it('falls back only for unsupported or unrecognized endpoints and never on auth denial', async () => {
    const request = vi.fn<RequestQuota>(async url => {
      if (String(url).endsWith('/api/status')) throw new QuotaError('unsupported');
      return { mode: 'unrestricted', unit: 'USD', balance: 3 };
    });
    expect((await readRelayQuota(request, root, { profile: 'token', token: 'fixture' })).balances[0]?.amount).toBe(3);
    const denied = vi.fn<RequestQuota>(async () => { throw new QuotaError('forbidden'); });
    await expect(readRelayQuota(denied, root, { profile: 'token', token: 'fixture', sub2api: true })).rejects.toMatchObject({ reason: 'forbidden' });
    expect(denied).toHaveBeenCalledOnce();
  });
});

it.each([['v8', '/v8/management/credentials', '/v8/management/requests/api-call'], ['v0-compat', '/v0/management/auth-files', '/v0/management/api-call']] as const)(
  'CPA %s uses exact profiles and auth indexes', async (profile, list, call) => {
    const request = vi.fn<RequestQuota>(async (_url, options) => options?.body === undefined
      ? { files: [{ auth_index: 'fixture-claude', provider: 'claude', disabled: false, status: 'ready' }, { auth_index: 'fixture-filtered', provider: 'codex' }] }
      : { status_code: 200, body: JSON.stringify({ five_hour: { utilization: 25 } }) });
    const data = await readCpa(request, root, { profile, key: 'fixture-key', now, modelIds: [], filter: ['fixture-claude'] });
    expect(data).toMatchObject([{ upstream: 'claude', result: { windows: [{ id: '5h', remainingPercent: 75 }] } }]);
    expect(request.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([list, call]);
    expect(request.mock.calls[1]?.[1]?.body).toEqual({ auth_index: 'fixture-claude', method: 'GET', url: 'https://api.anthropic.com/api/oauth/usage', header: { Authorization: 'Bearer $TOKEN$', Accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20' } });
  },
);
