import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const AuthFile = z.object({
  auth_mode: z.literal('chatgpt').optional(),
  OPENAI_API_KEY: z.null().optional(),
  tokens: z.object({ access_token: z.string().min(1), account_id: z.string().min(1) }),
});

const Claims = z.object({
  exp: z.number().positive().finite(),
  'https://api.openai.com/auth': z.object({ chatgpt_account_id: z.string().min(1) }),
});

export function codexAuthPath(): string {
  const configured = process.env['CODEX_HOME']?.trim();
  return join(configured ? configured : join(homedir(), '.codex'), 'auth.json');
}

export async function readCodexCredential(path: string) {
  try {
    const auth = AuthFile.parse(JSON.parse(await readFile(path, 'utf8')));
    const parts = auth.tokens.access_token.split('.');
    if (parts.length !== 3) return undefined;
    const claims = Claims.parse(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')));
    const expires = claims.exp * 1000;
    if (expires <= Date.now() + 60_000 || claims['https://api.openai.com/auth'].chatgpt_account_id !== auth.tokens.account_id) return undefined;
    return { type: 'oauth' as const, access: auth.tokens.access_token, refresh: '', expires, accountId: auth.tokens.account_id };
  } catch {
    return undefined;
  }
}
