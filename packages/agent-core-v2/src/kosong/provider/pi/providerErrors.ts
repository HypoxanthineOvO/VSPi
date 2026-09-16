import { APIContextOverflowError, APIProviderBusinessError, type ApiErrorKind, type ChatProviderError } from '#/kosong/contract/errors';
import { relayNativeProvider } from './catalog';

export interface ProviderErrorDetail {
  code?: string;
  type?: string;
  message?: string;
}

export function providerErrorDetail(value: unknown, depth = 0): ProviderErrorDetail | undefined {
  if (depth > 5 || typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const nested = record['error'];
  if (nested !== undefined && nested !== null) return providerErrorDetail(nested, depth + 1);
  const code = record['code'] ?? record['status_code'];
  const type = record['type'];
  const message = record['message'] ?? record['status_msg'];
  if (typeof code !== 'string' && typeof code !== 'number' && typeof type !== 'string' && typeof message !== 'string') return undefined;
  return {
    code: typeof code === 'string' || typeof code === 'number' ? String(code).slice(0, 160) : undefined,
    type: typeof type === 'string' ? type.slice(0, 160) : undefined,
    message: typeof message === 'string' ? message.slice(0, 4096) : undefined,
  };
}

export function errorProvider(provider: string | undefined, model: string): string {
  const aliases: Record<string, string> = { kimi: 'moonshotai', zhipu: 'zai', glm: 'zai', bigmodel: 'zai', dashscope: 'alibaba', qwen: 'alibaba', openai_responses: 'openai' };
  const canonical = aliases[provider ?? ''] ?? provider;
  return canonical !== undefined && ['moonshotai', 'zai', 'deepseek', 'minimax', 'alibaba'].includes(canonical)
    ? canonical : relayNativeProvider(model) ?? canonical ?? 'unknown';
}

export function classifyProviderBusinessError(
  provider: string,
  detail: ProviderErrorDetail,
  status: number | undefined,
  diagnostics: Readonly<Record<string, unknown>>,
  retryAfterMs?: number | null,
): ChatProviderError | undefined {
  const code = detail.code ?? detail.type ?? '';
  const type = detail.type ?? code;
  let kind: ApiErrorKind | undefined;
  if (provider === 'zai') {
    if (['1113', '1304', '1308', '1309', '1310', '1313', '1314', '1316', '1317', '1318', '1319', '1320', '1321'].includes(code)) kind = 'quota_exhausted';
    else if (['1000', '1001', '1002', '1003', '1004', '1005', '1220', '1311', '1315'].includes(code)) kind = 'auth';
    else if (['1302', '1303'].includes(code)) kind = 'rate_limit';
    else if (['1305', '1312'].includes(code)) kind = 'overloaded';
    else if (code === '1261') kind = 'context_overflow';
    else if (code === '1301') kind = 'filtered';
    else if (['500', '1200', '1230', '1234'].includes(code)) kind = '5xx_server';
    else if (/^(?:11\d\d|12\d\d)$/.test(code)) kind = '4xx_client';
  } else if (provider === 'moonshotai') {
    if (['exceeded_current_quota_error', 'insufficient_quota'].includes(type) || code === 'exceeded_current_quota_error') kind = 'quota_exhausted';
    else if (['rate_limit_reached_error', 'rate_limit_error'].includes(type)) kind = 'rate_limit';
    else if (type === 'invalid_authentication_error') kind = 'auth';
    else if (type === 'content_filter') kind = 'filtered';
  } else if (provider === 'deepseek' && status === 402) kind = 'quota_exhausted';
  else if (provider === 'minimax') {
    if (['1008', '2056'].includes(code)) kind = 'quota_exhausted';
    else if (['1004', '2049'].includes(code)) kind = 'auth';
    else if (['1002', '1039', '1041'].includes(code)) kind = 'rate_limit';
    else if (['1000', '1001', '1024', '1033'].includes(code)) kind = '5xx_server';
    else if (['1026', '1027'].includes(code)) kind = 'filtered';
    else if (code === '2013') kind = '4xx_client';
  } else if (provider === 'alibaba') {
    if (['Arrearage', 'CommodityNotPurchased', 'PrepaidBillOverdue', 'PostpaidBillOverdue'].includes(code)) kind = 'quota_exhausted';
    else if (code.startsWith('Throttling') || code === 'insufficient_quota') kind = 'rate_limit';
    else if (['DataInspectionFailed', 'data_inspection_failed'].includes(code)) kind = 'filtered';
  } else if (provider === 'openai' && (type === 'insufficient_quota' || ['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active'].includes(code))) kind = 'quota_exhausted';
  if (kind === undefined) {
    if (['overloaded_error', 'server_overloaded'].includes(type)) kind = 'overloaded';
    else if (['server_error', 'api_error', 'internal_error'].includes(code) || type === 'api_error') kind = '5xx_server';
    else if (type === 'rate_limit_error' || code === 'rate_limit_exceeded') kind = 'rate_limit';
    else if (['authentication_error', 'permission_error'].includes(type)) kind = 'auth';
    else if (code === 'context_length_exceeded') kind = 'context_overflow';
    else if (['content_filter', 'sensitive'].includes(code)) kind = 'filtered';
  }
  if (kind === undefined) return undefined;
  const message = detail.message ?? `Provider returned ${code || type}`;
  if (kind === 'context_overflow') return new APIContextOverflowError(status ?? 400, message);
  const retryable = ['rate_limit', 'overloaded', '5xx_server'].includes(kind);
  return new APIProviderBusinessError(kind, retryable, status ?? (retryable ? 503 : 400), message, {
    ...diagnostics, provider, providerErrorCode: detail.code, providerErrorType: detail.type,
  }, retryAfterMs);
}
