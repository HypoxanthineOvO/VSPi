import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { MAX_FEEDBACK_BYTES, parseFeedbackBundle } from './bundle.js';
import { createPrivateFile, readPrivateFile } from '../utils/private-file.js';
import { feedbackIdentity, feedbackIdentityPath, type FeedbackIdentity } from './identity.js';

export const FEEDBACK_ENDPOINT = 'https://dist.hypohub.cn/api/feedback';
const ENDPOINTS = new Set([FEEDBACK_ENDPOINT, 'https://dist-internal.hypohub.cn/api/feedback']);
export interface FeedbackUploadConfig {
  endpoint: string;
  token: string;
  id?: string;
}

interface FeedbackClientOptions { fetch?: typeof fetch; signal?: AbortSignal }

export async function readPrivateFeedbackFile(
  path: string,
  limit = MAX_FEEDBACK_BYTES,
): Promise<Buffer> {
  return readPrivateFile(path, limit);
}

export async function readFeedbackUploadConfig(home: string, options: FeedbackClientOptions = {}): Promise<FeedbackUploadConfig> {
  try { return await readConfig(join(home, 'feedback.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const identity = feedbackIdentity();
  const path = feedbackIdentityPath(home, identity);
  try { return await readConfig(path, identity); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(FEEDBACK_ENDPOINT, {
      method: 'POST', redirect: 'error', signal: uploadSignal(options.signal),
      headers: { 'content-type': 'application/json', 'x-feedback-action': 'register', 'x-feedback-consent': 'reviewed-v1' },
      body: JSON.stringify({ device: identity.device, username: identity.username }),
    });
  } catch {
    throw new Error(options.signal?.aborted ? 'Feedback 已取消' : 'Feedback 自动登记未完成，请检查网络后重试；无需领取凭据');
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 404 || response.status === 503)
      throw new Error('Feedback 接收服务尚未开放自动登记，请稍后重试；无需手工配置凭据');
    throw new Error(`Feedback 自动登记暂未完成（HTTP ${response.status}），请稍后重试`);
  }
  const registered = await boundedJson(response) as Partial<FeedbackUploadConfig>;
  if (!registered || registered.id !== identity.id || typeof registered.token !== 'string' ||
      !registered.token.startsWith('vspi1.') || registered.token.length > 2048)
    throw new Error('Feedback 自动登记返回了无效身份，请稍后重试');
  options.signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await createPrivateFile(path, Buffer.from(JSON.stringify({ endpoint: FEEDBACK_ENDPOINT, token: registered.token, id: identity.id })));
  return readConfig(path, identity);
}

async function readConfig(path: string, identity?: FeedbackIdentity): Promise<FeedbackUploadConfig> {
  let config: Partial<FeedbackUploadConfig>;
  const bytes = await readPrivateFeedbackFile(path, 16384);
  try {
    config = JSON.parse(bytes.toString('utf8')) as Partial<FeedbackUploadConfig>;
  } catch {
    throw new Error('Feedback 配置不是合法 JSON，请在本地修复');
  }
  if (!config || typeof config.token !== 'string' || config.token.length < 32 || config.token.length > 2048)
    throw new Error('本地 Feedback 身份配置无效');
  if (identity && config.id !== identity.id) throw new Error('本地 Feedback 身份与当前设备用户不一致');
  const endpoint = config.endpoint ?? FEEDBACK_ENDPOINT;
  if (!ENDPOINTS.has(endpoint)) throw new Error('Feedback endpoint is not trusted');
  return { endpoint, token: config.token, id: config.id };
}

export function feedbackDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateUpload(bytes: Buffer, reviewedDigest: string) {
  if (feedbackDigest(bytes) !== reviewedDigest)
    throw new Error('Feedback changed after preview; review it again');
  const bundle = parseFeedbackBundle(bytes);
  if (!bytes.equals(Buffer.from(JSON.stringify(bundle))))
    throw new Error(
      'Feedback must be re-exported before upload; sanitized preview differs from the file',
    );
  return bundle;
}

function uploadSignal(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
    : AbortSignal.timeout(60000);
}

export async function submitFeedback(bytes: Buffer, reviewedDigest: string, home: string, options: FeedbackClientOptions = {}): Promise<string> {
  validateUpload(bytes, reviewedDigest);
  const config = await readFeedbackUploadConfig(home, options);
  return uploadFeedback(bytes, reviewedDigest, config, options);
}

export async function uploadFeedback(
  bytes: Buffer,
  reviewedDigest: string,
  config: FeedbackUploadConfig,
  options: FeedbackClientOptions = {},
): Promise<string> {
  if (!ENDPOINTS.has(config.endpoint)) throw new Error('Feedback endpoint is not trusted');
  const bundle = validateUpload(bytes, reviewedDigest);
  const signal = uploadSignal(options.signal);
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
  const receipt = await boundedJson(response) as { id?: unknown; status?: unknown };
  if (!receipt || receipt.id !== bundle.id || receipt.status !== 'stored')
    throw new Error('Feedback 接收确认不匹配；本地包已保留');
  return bundle.id;
}

async function boundedJson(response: Response): Promise<unknown> {
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
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new Error('Feedback 接收端返回了无效确认，请稍后重试'); }
}
