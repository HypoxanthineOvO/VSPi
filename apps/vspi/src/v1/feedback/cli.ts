import { join, resolve } from 'node:path';
import { resolveRuntimePaths, type RuntimeConnection } from '@vsp/vsp-runtime';
import { requireExperimental } from '../../experimental.js';
import { collectFeedback } from './collect.js';
import { createFeedbackBundle, parseFeedbackBundle, saveFeedbackBundle } from './bundle.js';
import {
  feedbackDigest,
  readFeedbackUploadConfig,
  readPrivateFeedbackFile,
  uploadFeedback,
} from './client.js';

export const FEEDBACK_USAGE = `vspi feedback export --description <text> [--session <id>] [--turns 0|1|3]
vspi feedback preview <private-file>
vspi feedback redact <edited-private-file>
vspi feedback submit <private-file> --confirm-sha256 <preview-hash>
export 不上传；preview 显示完整脱敏包及 SHA256；submit 只发送明确确认且未改变的包。
上传凭据：VSPI_HOME/feedback.json，私有文件，独立 token，不要复用模型 API Key。
`;

export async function dispatchFeedback(
  args: readonly string[],
  options: {
    write: (text: string) => void;
    connect?: () => Promise<RuntimeConnection>;
    home?: string;
    fetch?: typeof fetch;
  },
): Promise<void> {
  if (args.length === 0 || args[0] === '--help') {
    options.write(FEEDBACK_USAGE);
    return;
  }
  requireExperimental('feedback');
  const home = resolveRuntimePaths(options.home).homeDir;
  if (args[0] === 'redact' && args.length === 2) {
    const original = parseFeedbackBundle(await readPrivateFeedbackFile(resolve(args[1]!)));
    const bundle = createFeedbackBundle(original);
    bundle.truncated ||= original.truncated;
    const path = await saveFeedbackBundle(join(home, 'feedback/outbox'), bundle);
    options.write(`已重新脱敏并分配新编号，尚未上传：${path}\n请重新 preview 和确认。\n`);
    return;
  }
  if (args[0] === 'export') {
    const values = new Map<string, string>();
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i];
      const value = args[i + 1];
      if (
        !key ||
        !['--description', '--session', '--turns'].includes(key) ||
        value === undefined ||
        values.has(key)
      )
        throw new Error(FEEDBACK_USAGE);
      values.set(key, value);
    }
    const turns = values.get('--turns') ?? (values.has('--session') ? '1' : '0');
    if (!['0', '1', '3'].includes(turns)) throw new Error(FEEDBACK_USAGE);
    if (turns !== '0' && !values.has('--session'))
      throw new Error('采集对话需要明确指定 --session；离线诊断请使用 --turns 0');
    const bundle = await collectFeedback({
      description: values.get('--description') ?? '',
      home,
      turns: Number(turns) as 0 | 1 | 3,
      sessionId: values.get('--session'),
      connect: options.connect,
    });
    const path = await saveFeedbackBundle(join(home, 'feedback', 'outbox'), bundle);
    options.write(
      `已保存私有诊断包（尚未上传）：${path}\n请先运行 vspi feedback preview "${path}"\n`,
    );
    return;
  }
  if (
    (args[0] === 'preview' && args.length === 2) ||
    (args[0] === 'submit' && args.length === 4 && args[2] === '--confirm-sha256')
  ) {
    const path = resolve(args[1]!);
    const bytes = await readPrivateFeedbackFile(path);
    const bundle = parseFeedbackBundle(bytes);
    if (!bytes.equals(Buffer.from(JSON.stringify(bundle))))
      throw new Error(
        '包需要重新脱敏：先运行 vspi feedback redact <file>，不能上传与安全预览不一致的文件',
      );
    if (args[0] === 'preview') {
      options.write(
        `${JSON.stringify(bundle, null, 2)}\nSHA256: ${feedbackDigest(
          bytes,
        )}\n包含的文本可能有未识别的秘密，请检查后再确认。\n`,
      );
      return;
    }
    const id = await uploadFeedback(bytes, args[3]!, await readFeedbackUploadConfig(home), {
      fetch: options.fetch,
    });
    options.write(`Feedback ${id} 已由接收端确认保存；本地包保留在 ${path}\n`);
    return;
  }
  throw new Error(FEEDBACK_USAGE);
}
