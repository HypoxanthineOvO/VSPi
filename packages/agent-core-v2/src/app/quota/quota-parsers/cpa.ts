import { bearer, checkStatus, failure, instant, object, QuotaError, retry, type Failure, type Reading, type RequestQuota } from './common';
import { CLAUDE_OAUTH_BETA, CLAUDE_USAGE_URL, CODEX_USAGE_URL } from './official';
import { claude, codex } from './upstream';

const profiles = {
  v8: { list: 'v8/management/credentials', call: 'v8/management/requests/api-call' },
  'v0-compat': { list: 'v0/management/auth-files', call: 'v0/management/api-call' },
};

export interface CpaReading {
  ref: string;
  upstream?: 'claude' | 'codex';
  result: Reading | Failure;
}

export async function readCpa(request: RequestQuota, root: URL, options: {
  profile: keyof typeof profiles; key: string; filter?: readonly string[]; modelIds: readonly string[]; now: number;
}): Promise<CpaReading[]> {
  const profile = profiles[options.profile], headers = bearer(options.key);
  const envelope = object(await retry(() => request(new URL(profile.list, root), { headers })));
  if (!Array.isArray(envelope['files']) || envelope['has_more'] === true) throw new QuotaError('schema_mismatch');
  const rows = envelope['files'].map(object), seen = new Set<string>();
  const selected = rows.flatMap(row => {
    const ref = row['auth_index'];
    if (typeof ref !== 'string' || !ref || seen.has(ref) ||
      row['disabled'] !== undefined && typeof row['disabled'] !== 'boolean' ||
      row['requires_sign_in'] !== undefined && typeof row['requires_sign_in'] !== 'boolean') throw new QuotaError('schema_mismatch');
    seen.add(ref);
    return options.filter === undefined || options.filter.includes(ref) ? [{ ref, row }] : [];
  });
  if (selected.length === 0) throw new QuotaError('account_unmatched');
  return Promise.all(selected.map(async ({ ref, row }): Promise<CpaReading> => {
    const provider = row['provider'] ?? row['type'];
    const upstream = provider === 'claude' || provider === 'codex' ? provider : undefined;
    let result: Reading | Failure;
    try {
      if (row['disabled'] === true || row['status'] === 'disabled') throw new QuotaError('disabled');
      const expires = instant(row['expires_at'] ?? row['expires']);
      if (row['requires_sign_in'] === true || row['status'] === 'requires_sign_in' || expires !== undefined && expires <= options.now) {
        throw new QuotaError('auth_expired');
      }
      if (!upstream) throw new QuotaError('unsupported');
      const isClaude = upstream === 'claude';
      const header: Record<string, string> = { Authorization: 'Bearer $TOKEN$', Accept: 'application/json' };
      if (isClaude) header['anthropic-beta'] = CLAUDE_OAUTH_BETA;
      else header['originator'] = 'codex_cli_rs';
      result = await retry(async () => {
        const outer = object(await request(new URL(profile.call, root), {
          headers, body: { auth_index: ref, method: 'GET', url: isClaude ? CLAUDE_USAGE_URL : CODEX_USAGE_URL, header },
        }));
        if (typeof outer['status_code'] !== 'number') throw new QuotaError('schema_mismatch');
        checkStatus(outer['status_code']);
        if (typeof outer['body'] !== 'string') throw new QuotaError('schema_mismatch');
        let data: unknown;
        try { data = JSON.parse(outer['body']); } catch { throw new QuotaError('schema_mismatch'); }
        return isClaude ? claude(data, options.modelIds) : codex(data, options.now);
      });
    } catch (error) { result = failure(error); }
    return { ref, upstream, result };
  }));
}
