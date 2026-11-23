import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderRequestAuth } from '#/llm-adapter/contract/provider';
import { listPiProviders } from '#/llm-adapter/provider/pi/catalog';
import type { LocalCredentialContext } from './localCredentials';

const supportedProviders = new Set([
  'openai', 'openai-codex', 'anthropic', 'google', 'kimi-coding', 'deepseek', 'zai',
  'zai-coding-cn', 'minimax', 'minimax-cn', 'moonshotai', 'moonshotai-cn',
]);
const endpoints = new Map(listPiProviders().filter(({ id }) => supportedProviders.has(id)).map(({ id, baseUrl }) => [id, baseUrl]));

export class OmpCredentialExpiredError extends Error {
  constructor() {
    super('OMP 凭据已过期，请在 OMP 中刷新或改用 VSPi 独立登录');
    this.name = 'OmpCredentialExpiredError';
  }
}

interface OmpCredential {
  readonly provider: string;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly oauth: boolean;
  readonly expires?: number;
  readonly accountId?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && !/[\r\n]/u.test(value) ? value.trim() : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  return ms <= 8.64e15 ? ms : undefined;
}

function claims(access: string): Record<string, unknown> | undefined {
  const payload = access.split('.')[1];
  if (!payload) return undefined;
  try { return record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))); }
  catch { return undefined; }
}

function providerIdOf(provider: string): string {
  if (provider === 'gemini') return 'google';
  if (provider === 'zhipu' || provider === 'zhipu-coding-cn') return 'zai-coding-cn';
  if (provider === 'kimi-code') return 'kimi-coding';
  return provider;
}

function parseCredential(row: Record<string, unknown>): OmpCredential | undefined {
  const provider = nonempty(row['provider']);
  if (!provider || typeof row['data'] !== 'string') return undefined;
  const providerId = providerIdOf(provider);
  const baseUrl = endpoints.get(providerId);
  if (!baseUrl) return undefined;
  let data: Record<string, unknown> | undefined;
  try { data = record(JSON.parse(row['data'])); } catch { return undefined; }
  if (!data) return undefined;
  if (row['credential_type'] === 'api_key') {
    const apiKey = nonempty(data['key'] ?? data['apiKey'] ?? data['api_key']);
    return apiKey ? { provider, providerId, baseUrl, apiKey, oauth: false } : undefined;
  }
  if (row['credential_type'] !== 'oauth') return undefined;
  const tokens = record(data['tokens']) ?? data;
  const access = nonempty(tokens['access'] ?? tokens['access_token'] ?? tokens['accessToken']);
  if (!access) return undefined;
  const jwt = claims(access);
  const declared = timestamp(tokens['expires'] ?? tokens['expires_at'] ?? tokens['expiresAt'] ?? data['expires']);
  const jwtExpiry = timestamp(jwt?.['exp']);
  const expires = declared === undefined ? jwtExpiry : jwtExpiry === undefined ? declared : Math.min(declared, jwtExpiry);
  if (expires === undefined) return undefined;
  const accountId = nonempty(tokens['accountId'] ?? tokens['account_id'] ?? record(jwt?.['https://api.openai.com/auth'])?.['chatgpt_account_id']);
  return { provider, providerId, baseUrl, apiKey: access, oauth: true, expires, accountId };
}

function readCredentials(context: LocalCredentialContext): OmpCredential[] {
  const path = join(context.env['OMP_HOME']?.trim() || join(context.home, '.omp'), 'agent', 'agent.db');
  let db: DatabaseSync | undefined;
  try {
    if (!statSync(path).isFile()) return [];
    const url = pathToFileURL(path);
    url.searchParams.set('mode', 'ro');
    const hasWal = existsSync(`${path}-wal`);
    if (hasWal && !existsSync(`${path}-shm`) && statSync(`${path}-wal`).size > 0) return [];
    if (!hasWal || !existsSync(`${path}-shm`)) url.searchParams.set('immutable', '1');
    db = new DatabaseSync(url.href, { readOnly: true, timeout: 0 });
    return db.prepare(`SELECT provider, credential_type, data, disabled_cause, identity_key
      FROM auth_credentials WHERE disabled_cause IS NULL OR disabled_cause = ''`).all().flatMap(row => {
      const entry = parseCredential(row);
      return entry ? [entry] : [];
    });
  } catch { return []; }
  finally { try { db?.close(); } catch {} }
}

function preferred(rows: OmpCredential[], now: number): OmpCredential | undefined {
  return rows.find(row => row.expires === undefined || row.expires > now) ?? rows[0];
}

export function detectOmpCredentials(context: LocalCredentialContext): readonly { id: string; provider: string; name: string; expiresAt?: string }[] {
  const grouped = new Map<string, OmpCredential[]>();
  for (const row of readCredentials(context)) {
    const rows = grouped.get(row.provider);
    if (rows) rows.push(row);
    else grouped.set(row.provider, [row]);
  }
  return [...grouped.values()].flatMap(rows => {
    const row = preferred(rows, Date.now());
    return row ? [{
      id: `omp-${row.provider}`, provider: row.providerId, name: `OMP (${row.provider})`,
      expiresAt: row.expires === undefined ? undefined : new Date(row.expires).toISOString(),
    }] : [];
  });
}

export function resolveOmpCredential(context: LocalCredentialContext, id: string, provider?: string): ProviderRequestAuth | undefined {
  const now = Date.now();
  const row = preferred(readCredentials(context).filter(entry => `omp-${entry.provider}` === id && (provider === undefined || entry.providerId === provider)), now);
  if (!row) return undefined;
  if (row.expires !== undefined && row.expires <= now) throw new OmpCredentialExpiredError();
  const auth: ProviderRequestAuth = { apiKey: row.apiKey, baseUrl: row.baseUrl };
  if (row.oauth && row.providerId === 'anthropic') {
    auth.headers = { authorization: `Bearer ${row.apiKey}`, 'anthropic-beta': 'oauth-2025-04-20' };
    auth.removeHeaders = ['x-api-key'];
  }
  if (row.oauth && row.providerId === 'openai-codex' && row.accountId) {
    auth.headers = { 'chatgpt-account-id': row.accountId };
  }
  return auth;
}
