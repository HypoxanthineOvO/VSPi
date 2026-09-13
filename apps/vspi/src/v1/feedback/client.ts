import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MAX_FEEDBACK_BYTES, parseFeedbackBundle } from './bundle.js';
import { readPrivateFile } from '../utils/private-file.js';

export const FEEDBACK_ENDPOINT = 'https://dist.hypohub.cn/api/feedback';
const ENDPOINTS = new Set([FEEDBACK_ENDPOINT, 'https://dist-internal.hypohub.cn/api/feedback']);
export interface FeedbackUploadConfig {
  endpoint: string;
  token: string;
}

export async function readPrivateFeedbackFile(
  path: string,
  limit = MAX_FEEDBACK_BYTES,
): Promise<Buffer> {
  return readPrivateFile(path, limit);
}

export async function readFeedbackUploadConfig(home: string): Promise<FeedbackUploadConfig> {
  let config: Partial<FeedbackUploadConfig>;
  const bytes = await readPrivateFeedbackFile(join(home, 'feedback.json'), 16384);
  try {
    config = JSON.parse(bytes.toString('utf8')) as Partial<FeedbackUploadConfig>;
  } catch {
    throw new Error('Feedback 配置不是合法 JSON，请在本地修复');
  }
  if (typeof config.token !== 'string' || config.token.length < 32)
    throw new Error('请配置独立 Feedback 提交凭证，不要使用模型 API Key');
  const endpoint = config.endpoint ?? FEEDBACK_ENDPOINT;
  if (!ENDPOINTS.has(endpoint)) throw new Error('Feedback endpoint is not trusted');
  return { endpoint, token: config.token };
}

export function feedbackDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function uploadFeedback(
  bytes: Buffer,
  reviewedDigest: string,
  config: FeedbackUploadConfig,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  if (!ENDPOINTS.has(config.endpoint)) throw new Error('Feedback endpoint is not trusted');
  if (feedbackDigest(bytes) !== reviewedDigest)
    throw new Error('Feedback changed after preview; review it again');
  const bundle = parseFeedbackBundle(bytes);
  if (!bytes.equals(Buffer.from(JSON.stringify(bundle))))
    throw new Error(
      'Feedback must be re-exported before upload; sanitized preview differs from the file',
    );
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)])
    : AbortSignal.timeout(60000);
  const response = await (options.fetch ?? fetch)(config.endpoint, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
      'x-feedback-consent': 'reviewed-v1',
    },
    body: new Uint8Array(bytes),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Feedback 上传失败（HTTP ${response.status}）；本地包已保留，可重新提交`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Feedback 接收端未返回确认');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) throw new Error('Feedback confirmation exceeds size limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const receipt = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    id?: unknown;
    status?: unknown;
  };
  if (receipt.id !== bundle.id || receipt.status !== 'stored')
    throw new Error('Feedback 接收确认不匹配；本地包已保留');
  return bundle.id;
}
