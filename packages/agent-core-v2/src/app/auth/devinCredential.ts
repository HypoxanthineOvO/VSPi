import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from '@earendil-works/pi-ai';
import { Error2 } from '#/_base/errors/errors';
import { AuthErrors } from './errors';

export function devinAuthPath(): string { return join(homedir(), '.local', 'share', 'devin', 'credentials.toml'); }

export function devinCredential(token: string): OAuthCredential {
  const access = token.replace(/^devin-session-token\$/, '');
  let expires: number;
  try {
    const payload: unknown = JSON.parse(Buffer.from(access.split('.')[1] ?? '', 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') throw new Error();
    if ('exp' in payload) {
      if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) throw new Error();
      expires = payload.exp * 1000;
    } else {
      if (!('session_id' in payload) || typeof payload.session_id !== 'string' || !payload.session_id) throw new Error();
      expires = Number.MAX_SAFE_INTEGER;
    }
  } catch { throw loginRequired(); }
  if (expires <= Date.now() + 30_000) throw loginRequired();
  return { type: 'oauth', access, refresh: '', expires };
}

export async function readDevinCredential(path: string): Promise<OAuthCredential | undefined> {
  try {
    const parsed = parse(await readFile(path, 'utf8'));
    return typeof parsed['windsurf_api_key'] === 'string' ? devinCredential(parsed['windsurf_api_key']) : undefined;
  } catch { return undefined; }
}

function loginRequired(): Error2 {
  return new Error2(AuthErrors.codes.AUTH_LOGIN_REQUIRED, 'Devin login is unavailable or expired; re-login required. Run devin auth on the backend machine, or log in to Devin again in VSPi.');
}

export function devinAuthorization(redirectUri: string) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const url = new URL('https://app.devin.ai/auth/cli/continue');
  url.search = new URLSearchParams({ redirect_uri: redirectUri, prompt: 'select_account', state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  return { verifier, state, url: url.toString() };
}

export function devinCallback(input: string, state: string): string {
  const value = input.trim();
  if (/^https?:\/\//.test(value)) {
    const url = new URL(value);
    if (url.searchParams.get('state') !== state || url.searchParams.has('error')) throw new Error('Devin callback state mismatch or authorization denied.');
    const code = url.searchParams.get('code');
    if (!code) throw new Error('Devin callback has no authorization code.');
    return code;
  }
  const [code, suppliedState] = value.split('#');
  if (!code || (suppliedState !== undefined && suppliedState !== state)) throw new Error('Invalid Devin authorization code or state.');
  return code;
}

export async function exchangeDevinCode(code: string, verifier: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<OAuthCredential> {
  const response = await fetchImpl('https://api.devin.ai/auth/cli/token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier }), signal,
  });
  if (!response.ok) throw new Error(`Devin token exchange failed (${response.status}); please log in again.`);
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object' || !('token' in result) || typeof result.token !== 'string') throw new Error('Devin token exchange returned no token.');
  return devinCredential(result.token);
}

async function browserLogin(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const controller = new AbortController();
  const signal = AbortSignal.any([interaction.signal, controller.signal]);
  let resolveCallback!: (value: string) => void;
  const callback = new Promise<string>((resolve) => { resolveCallback = resolve; });
  let auth: ReturnType<typeof devinAuthorization>;
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? '', 'http://127.0.0.1');
      if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
      const code = devinCallback(url.toString(), auth.state);
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Devin login received. You can close this tab.');
      resolveCallback(code);
    } catch { response.writeHead(400).end('Invalid login callback.'); }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Devin login callback listener unavailable.');
    auth = devinAuthorization(`http://127.0.0.1:${address.port}/callback`);
    interaction.notify({ type: 'auth_url', url: auth.url, instructions: 'Open this URL to log in to Devin. Over SSH, paste the callback URL or authorization code below.' });
    const manual = interaction.prompt({ type: 'manual_code', message: 'Paste the Devin callback URL or authorization code (or complete login in your local browser)', signal })
      .then((input) => devinCallback(input, auth.state));
    const aborted = new Promise<never>((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason ?? new Error('Devin login cancelled.')), { once: true }); });
    signal.throwIfAborted();
    const code = await Promise.race([callback, manual, aborted]);
    return await exchangeDevinCode(code, auth.verifier, interaction.signal);
  } finally { controller.abort(); server.closeAllConnections(); server.close(); }
}

export const devinOAuth: OAuthAuth = {
  name: 'Devin', isSubscription: true,
  login: browserLogin,
  async refresh() { throw loginRequired(); },
  async toAuth(credential) { return { apiKey: devinCredential(credential.access).access }; },
};
