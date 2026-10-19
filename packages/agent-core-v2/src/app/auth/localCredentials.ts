import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { OAuthCredential } from '@earendil-works/pi-ai';
import type { ProviderRequestAuth } from '#/llm-adapter/contract/provider';
import { readCodexCredential } from './codexCredential';
import { readDevinCredential } from './devinCredential';

export interface LocalCredentialInfo {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly account?: string;
  readonly expiresAt?: string;
}

export interface LocalCredentialContext {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface LocalCredentialDetector {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  detect(context: LocalCredentialContext): Promise<Omit<LocalCredentialInfo, 'id' | 'provider' | 'name'> | undefined>;
  resolve(context: LocalCredentialContext): Promise<ProviderRequestAuth | undefined>;
}

const additionalDetectors = new Map<string, LocalCredentialDetector>();

export function registerLocalCredentialDetector(detector: LocalCredentialDetector): () => void {
  if (additionalDetectors.has(detector.id) || builtinDetectors.some(item => item.id === detector.id)) throw new Error('Local credential detector already registered.');
  additionalDetectors.set(detector.id, detector);
  return () => { if (additionalDetectors.get(detector.id) === detector) additionalDetectors.delete(detector.id); };
}

export class LocalCredentialRegistry {
  private copilotCache?: { token: string; expires: number; auth: ProviderRequestAuth };
  private copilotPending?: { token: string; promise: Promise<ProviderRequestAuth | undefined> };

  constructor(private readonly context: LocalCredentialContext = { home: homedir(), env: process.env }) {}

  async detect(): Promise<readonly LocalCredentialInfo[]> {
    const results = await Promise.all(this.detectors().map(async detector => {
      try {
        const info = await detector.detect(this.context);
        return info === undefined ? [] : [{ id: detector.id, provider: detector.provider, name: detector.name, account: info.account, expiresAt: info.expiresAt }];
      } catch { return []; }
    }));
    return results.flat();
  }

  async resolve(id: string, provider?: string, options?: { signal?: AbortSignal; fresh?: boolean }): Promise<ProviderRequestAuth | undefined> {
    const detector = this.detectors().find(item => item.id === id && (provider === undefined || item.provider === provider));
    if (!detector) return undefined;
    try {
      if (id !== 'github-copilot-cli') return await detector.resolve(this.context);
      const credential = await copilot(this.context);
      if (!credential) { this.copilotCache = undefined; return undefined; }
      if (options?.fresh) {
        const oauth = builtinProviders().find(item => item.id === 'github-copilot')?.auth.oauth;
        if (!oauth) return undefined;
        const timeout = AbortSignal.timeout(10_000);
        const refreshed = await oauth.refresh(credential, options.signal ? AbortSignal.any([options.signal, timeout]) : timeout);
        options.signal?.throwIfAborted();
        const auth = await piAuth('github-copilot', refreshed);
        if (auth) this.copilotCache = { token: credential.refresh, expires: refreshed.expires, auth };
        return auth;
      }
      if (this.copilotCache?.token === credential.refresh && this.copilotCache.expires > Date.now() + 60_000) return this.copilotCache.auth;
      if (this.copilotPending?.token === credential.refresh) return await this.copilotPending.promise;
      const promise = (async () => {
        const oauth = builtinProviders().find(item => item.id === 'github-copilot')?.auth.oauth;
        if (!oauth) return undefined;
        const refreshed = await oauth.refresh(credential, AbortSignal.timeout(10_000));
        const auth = await piAuth('github-copilot', refreshed);
        if (auth) this.copilotCache = { token: credential.refresh, expires: refreshed.expires, auth };
        return auth;
      })();
      const pending = { token: credential.refresh, promise };
      this.copilotPending = pending;
      try { return await promise; } finally { if (this.copilotPending === pending) this.copilotPending = undefined; }
    } catch { return undefined; }
  }

  private detectors(): readonly LocalCredentialDetector[] { return [...builtinDetectors, ...additionalDetectors.values()]; }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) return undefined;
      const value: unknown = JSON.parse(await file.readFile('utf8'));
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    } finally { await file.close(); }
  } catch { return undefined; }
}

async function codex(context: LocalCredentialContext) {
  return readCodexCredential(join(context.env['CODEX_HOME']?.trim() || join(context.home, '.codex'), 'auth.json'));
}

async function kimi(context: LocalCredentialContext) {
  const directory = join(context.home, '.kimi', 'credentials');
  let files: string[];
  try { files = (await readdir(directory)).filter(name => /^kimi-code[\w.-]*\.json$/.test(name)).sort().slice(0, 16); }
  catch { return undefined; }
  for (const file of files) {
    const value = await readJson(join(directory, file));
    if (typeof value?.['access_token'] !== 'string' || !value['access_token'].trim()) continue;
    const expires = value['expires_at'];
    if (typeof expires !== 'number' || !Number.isFinite(expires) || expires * 1000 <= Date.now() + 60_000) continue;
    return { access: value['access_token'], expires: expires * 1000 };
  }
  return undefined;
}

async function copilot(context: LocalCredentialContext): Promise<OAuthCredential | undefined> {
  const directory = join(context.env['XDG_CONFIG_HOME'] || join(context.home, '.config'), 'github-copilot');
  for (const file of ['apps.json', 'hosts.json']) {
    const value = await readJson(join(directory, file));
    for (const [host, raw] of Object.entries(value ?? {})) {
      if (host !== 'github.com' && !host.startsWith('github.com:')) continue;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      const token = record['oauth_token'];
      if (typeof token !== 'string' || !token.trim()) continue;
      return { type: 'oauth', access: '', refresh: token, expires: 0 };
    }
  }
  return undefined;
}

async function piAuth(provider: string, credential: OAuthCredential | undefined): Promise<ProviderRequestAuth | undefined> {
  if (!credential) return undefined;
  const oauth = builtinProviders().find(item => item.id === provider)?.auth.oauth;
  if (!oauth) return undefined;
  const current = credential.expires <= Date.now() + 60_000 ? await oauth.refresh(credential, AbortSignal.timeout(10_000)) : credential;
  const auth = await oauth.toAuth(current);
  const headers = Object.entries(auth.headers ?? {});
  return { apiKey: auth.apiKey, baseUrl: auth.baseUrl,
    headers: Object.fromEntries(headers.filter((entry): entry is [string, string] => entry[1] !== null)),
    removeHeaders: headers.filter(([, value]) => value === null).map(([name]) => name) };
}

const builtinDetectors: readonly LocalCredentialDetector[] = [
  { id: 'devin-cli', provider: 'devin', name: 'Devin CLI',
    detect: async context => { const value = await readDevinCredential(join(context.home, '.local', 'share', 'devin', 'credentials.toml')); return value ? { expiresAt: value.expires === Number.MAX_SAFE_INTEGER ? undefined : new Date(value.expires).toISOString() } : undefined; },
    resolve: async context => { const value = await readDevinCredential(join(context.home, '.local', 'share', 'devin', 'credentials.toml')); return value ? { apiKey: value.access } : undefined; } },
  { id: 'codex-cli', provider: 'openai-codex', name: 'Codex CLI',
    detect: async context => { const value = await codex(context); return value ? { account: value.accountId, expiresAt: new Date(value.expires).toISOString() } : undefined; },
    resolve: async context => { const auth = await piAuth('openai-codex', await codex(context)); return auth ? { ...auth, baseUrl: 'https://chatgpt.com/backend-api' } : undefined; } },
  { id: 'kimi-cli', provider: 'kimi-coding', name: 'Kimi CLI',
    detect: async context => { const value = await kimi(context); return value ? { expiresAt: new Date(value.expires).toISOString() } : undefined; },
    resolve: async context => { const value = await kimi(context); return value ? { apiKey: value.access, baseUrl: 'https://api.kimi.com/coding' } : undefined; } },
  { id: 'github-copilot-cli', provider: 'github-copilot', name: 'GitHub Copilot CLI',
    detect: async context => (builtinProviders().some(item => item.id === 'github-copilot' && item.auth.oauth) && await copilot(context)) ? {} : undefined,
    resolve: async context => piAuth('github-copilot', await copilot(context)) },
];
