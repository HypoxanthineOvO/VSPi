import { balance, bearer, failure, numeric, object, QuotaError, reading, requireReading, window, type Reading, type RequestQuota } from './common';

function envelope(value: unknown): Record<string, unknown> {
  const data = object(value);
  if (data['success'] !== true || data['code'] === false || !data['data'] || typeof data['data'] !== 'object' || Array.isArray(data['data'])) {
    throw new QuotaError('schema_mismatch');
  }
  return object(data['data']);
}

export async function readNewApi(request: RequestQuota, root: URL, options: {
  profile: 'account' | 'token'; token: string; userId?: string; multiplier?: number;
}): Promise<Reading> {
  const headers = bearer(options.token);
  if (options.profile === 'account' && options.userId !== undefined) {
    if (!/^\d+$/.test(options.userId)) throw new QuotaError('schema_mismatch');
    headers['new-api-user'] = options.userId;
  }
  const metadata = envelope(await request(new URL('api/status', root)));
  const perUnit = numeric(metadata['quota_per_unit']), display = metadata['quota_display_type'];
  if (perUnit === undefined || perUnit <= 0 || typeof display !== 'string' || !display.trim()) {
    throw new QuotaError('schema_mismatch');
  }
  const currency = display === 'USD' || display === 'CNY' ? display : 'POINTS';
  const scale = currency === 'POINTS' ? 1 : perUnit;
  const token = options.profile === 'token';
  const data = envelope(await request(new URL(token ? 'api/usage/token/' : 'api/user/self', root), { headers }));
  const id = token ? 'token.limit' : 'account.balance';
  if (token && typeof data['unlimited_quota'] !== 'boolean') throw new QuotaError('schema_mismatch');
  if (token && data['unlimited_quota'] === true) return { windows: [], balances: [balance(id, currency, 0, { unlimited: true })] };
  const left = numeric(token ? data['total_available'] : data['quota']);
  if (left === undefined || !Number.isFinite(left / scale)) throw new QuotaError('schema_mismatch');
  const total = token ? numeric(data['total_granted']) : undefined;
  const limit = total !== undefined && total >= 0 && Number.isFinite(total / scale) ? total / scale : undefined;
  const multiplier = options.multiplier ?? numeric(data['group_ratio']);
  return { windows: [], balances: [balance(id, currency, left / scale, { limit, multiplier })] };
}

export function decodeSub2Api(value: unknown, multiplier?: number): Reading {
  const data = object(value), result = reading();
  if (data['isValid'] === false || data['status'] === 'expired') throw new QuotaError('auth_expired');
  if (data['mode'] === 'quota_limited') {
    const quota = object(data['quota']), remaining = numeric(quota['remaining'] ?? data['remaining']), limit = numeric(quota['limit']);
    if ((quota['unit'] ?? data['unit']) === 'USD' && remaining !== undefined) {
      result.balances.push(balance('token.limit', 'USD', remaining, { limit, multiplier }));
    }
    if (Array.isArray(data['rate_limits'])) for (const raw of data['rate_limits']) {
      const entry = object(raw), id = entry['window'], cap = numeric(entry['limit']), left = numeric(entry['remaining']);
      if ((id === '5h' || id === '1d' || id === '7d') && cap !== undefined && cap > 0 && left !== undefined) {
        const windowId = id === '1d' ? 'daily' : id;
        window(result, windowId, id, Math.max(0, Math.min(100, left / cap * 100)), entry['reset_at']);
      }
    }
  } else if (data['mode'] === 'unrestricted' && data['unit'] === 'USD') {
    if (data['subscription'] !== undefined) {
      const subscription = object(data['subscription']);
      const remaining = numeric(data['remaining']);
      if (remaining === -1) {
        result.balances.push(balance('subscription.allowance', 'USD', 0, { label: '订阅额度', unlimited: true }));
      } else if (remaining !== undefined && remaining >= 0) {
        result.balances.push(balance('subscription.allowance', 'USD', remaining, { label: '订阅额度', multiplier }));
      }
      for (const [unit, id, label] of [['daily', 'daily', '1d'], ['weekly', '7d', '7d'], ['monthly', 'monthly', '月度']] as const) {
        const used = numeric(subscription[`${unit}_usage_usd`]), limit = numeric(subscription[`${unit}_limit_usd`]);
        if (used !== undefined && limit !== undefined && limit > 0) window(result, id, label, Math.max(0, Math.min(100, (1 - used / limit) * 100)));
      }
    } else {
      const wallet = numeric(data['balance'] ?? data['remaining']);
      if (wallet !== undefined) result.balances.push(balance('account.balance', 'USD', wallet, { multiplier }));
    }
  }
  return requireReading(result);
}

export async function readRelayQuota(request: RequestQuota, root: URL, options: {
  profile: 'account' | 'token'; token: string; userId?: string; multiplier?: number; sub2api?: boolean;
}): Promise<Reading> {
  if (options.profile === 'account') return readNewApi(request, root, options);
  const sub2api = async () => decodeSub2Api(await request(new URL('v1/usage', root), { headers: bearer(options.token) }), options.multiplier);
  try {
    return await (options.sub2api ? sub2api() : readNewApi(request, root, options));
  } catch (error) {
    if (failure(error) !== 'unsupported' && failure(error) !== 'schema_mismatch') throw error;
    return options.sub2api ? readNewApi(request, root, options) : sub2api();
  }
}
