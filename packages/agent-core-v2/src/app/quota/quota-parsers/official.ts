import type { ProviderQuotaRegion, QuotaCategory } from '../quota-contract';
import { bearer, object, QuotaError, type Reading, type RequestQuota } from './common';
import * as upstream from './upstream';

const codexHosts = ['chatgpt.com', 'api.openai.com'];
const claudeHosts = ['api.anthropic.com'];
const deepseekHosts = ['api.deepseek.com'];
const kimiHosts = ['api.kimi.com', 'api.kimi.ai', 'api.moonshot.cn', 'api.moonshot.ai'];
const glmHosts = ['open.bigmodel.cn', 'api.z.ai', 'api.bigmodel.cn'];
const minimaxHosts = ['api.minimax.cn', 'api.minimax.io', 'api.minimaxi.com'];
const devinHosts = ['server.codeium.com', 'app.devin.ai', 'api.devin.ai'];
const googleHosts = ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com', 'generativelanguage.googleapis.com'];

interface OfficialAccess {
  token: string;
  region: ProviderQuotaRegion;
  modelIds: readonly string[];
  projectId?: string;
}

interface OfficialQuotaSource {
  aliases: string[];
  hosts: string[];
  category: QuotaCategory;
  read(input: {
    request: RequestQuota;
    access: OfficialAccess;
    headers: Record<string, string>;
    now: number;
  }): Promise<Reading>;
}

export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';

export const official = {
  codex: {
    aliases: ['openai-codex', 'codex'], hosts: codexHosts, category: 'subscription',
    async read({ request, access, headers, now }) {
      headers['originator'] = 'codex_cli_rs';
      try {
        const claims = object(JSON.parse(Buffer.from(access.token.split('.')[1] ?? '', 'base64url').toString()));
        const account = object(claims['https://api.openai.com/auth'])['chatgpt_account_id'];
        if (typeof account === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(account)) headers['chatgpt-account-id'] = account;
      } catch {}
      return upstream.codex(await request(CODEX_USAGE_URL, { headers }), now);
    },
  },
  claude: {
    aliases: ['anthropic', 'claude'], hosts: claudeHosts, category: 'subscription',
    async read({ request, access, headers }) {
      headers['anthropic-beta'] = CLAUDE_OAUTH_BETA;
      return upstream.claude(await request(CLAUDE_USAGE_URL, { headers }), access.modelIds);
    },
  },
  deepseek: {
    aliases: ['deepseek'], hosts: deepseekHosts, category: 'balance',
    async read({ request, headers }) {
      return upstream.deepseek(await request('https://api.deepseek.com/user/balance', { headers }));
    },
  },
  kimi: {
    aliases: ['kimi', 'kimi-code', 'kimi-coding', 'moonshotai', 'moonshotai-cn', 'moonshot'], hosts: kimiHosts, category: 'subscription',
    async read({ request, access, headers }) {
      const host = access.region === 'global' ? 'api.kimi.ai' : 'api.kimi.com';
      return upstream.kimi(await request(`https://${host}/coding/v1/usages`, { headers }));
    },
  },
  glm: {
    aliases: ['glm', 'zai', 'zai-coding', 'zai-coding-cn', 'zhipu'], hosts: glmHosts, category: 'subscription',
    async read({ request, access }) {
      const host = access.region === 'global' ? 'api.z.ai' : 'open.bigmodel.cn';
      return upstream.glm(await request(`https://${host}/api/monitor/usage/quota/limit`, { headers: { authorization: access.token } }));
    },
  },
  minimax: {
    aliases: ['minimax', 'minimax-cn'], hosts: minimaxHosts, category: 'subscription',
    async read({ request, access, headers }) {
      if (access.token.startsWith('sk-api-')) throw new QuotaError('unsupported');
      const host = access.region === 'global' ? 'api.minimax.io' : 'api.minimax.cn';
      return upstream.minimax(await request(`https://${host}/v1/token_plan/remains`, { headers }), access.modelIds);
    },
  },
  devin: {
    aliases: ['devin'], hosts: devinHosts, category: 'subscription',
    async read({ request, access }) {
      const key = access.token.startsWith('devin-session-token$') ? access.token : `devin-session-token$${access.token}`;
      const url = 'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus';
      return upstream.devin(await request(url, {
        headers: { 'x-api-key': key, 'connect-protocol-version': '1' },
        body: { metadata: { ide_name: 'devin-cli', ide_version: '3000.11.3', extension_name: 'devin', extension_version: '3000.11.3', api_key: key, locale: 'en-US', os: process.platform, auth_source: 'API_KEY' } },
      }));
    },
  },
  antigravity: {
    aliases: ['google-antigravity', 'antigravity'], hosts: googleHosts, category: 'subscription',
    async read({ request, access, headers }) {
      if (!access.projectId || !/^[A-Za-z0-9_-]{1,128}$/.test(access.projectId)) throw new QuotaError('no_credential');
      headers['user-agent'] = 'antigravity/2.23.0 linux/amd64';
      return upstream.antigravity(await request('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', {
        headers, body: { project: access.projectId },
      }), access.modelIds);
    },
  },
} satisfies Record<string, OfficialQuotaSource>;

export type OfficialKind = keyof typeof official;

export function matchOfficial(id: string, type: string | undefined, base: string | undefined): OfficialKind | undefined {
  let hostname: string | undefined;
  if (base !== undefined) {
    try {
      const url = new URL(base);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return undefined;
      hostname = url.hostname;
    } catch { return undefined; }
  }
  for (const kind of Object.keys(official) as OfficialKind[]) {
    const { aliases, hosts } = official[kind];
    if (hostname !== undefined && !hosts.includes(hostname)) continue;
    if (aliases.includes(id) || type !== undefined && aliases.includes(type) || hostname === 'api.deepseek.com') return kind;
  }
  return undefined;
}

export function inferRegion(id: string, type: string | undefined, base: string | undefined): ProviderQuotaRegion {
  if (base !== undefined) {
    const hostname = new URL(base).hostname;
    if (['api.kimi.ai', 'api.moonshot.ai', 'api.z.ai', 'api.minimax.io'].includes(hostname)) return 'global';
    if (['api.kimi.com', 'api.moonshot.cn', 'open.bigmodel.cn', 'api.bigmodel.cn', 'api.minimax.cn', 'api.minimaxi.com'].includes(hostname)) return 'cn';
  }
  if (id.endsWith('-cn') || type?.endsWith('-cn') || id === 'zhipu') return 'cn';
  return ['minimax', 'zai', 'zai-coding', 'moonshotai'].includes(type ?? id) ? 'global' : 'cn';
}

export async function readOfficial(request: RequestQuota, kind: OfficialKind, access: OfficialAccess, now: number): Promise<Reading> {
  return official[kind].read({ request, access, headers: bearer(access.token), now });
}
