import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { connectRuntime, resolveRuntimePaths, type RuntimeConnection } from '@vsp/vsp-runtime';
import type { TranscriptMessage } from '../domain/types.js';
import { VSPI_VERSION } from '../version.js';
import {
  createFeedbackBundle,
  feedbackSecrets,
  type FeedbackBundle,
  type FeedbackEntry,
} from './bundle.js';

async function limitedFile(path: string, limit: number, tail = false): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || (!tail && info.size > limit))
      throw new Error('Diagnostic source exceeds collection limit');
    const start = tail ? Math.max(0, info.size - limit) : 0;
    const buffer = Buffer.alloc(Math.min(info.size, limit));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let value = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) value = value.includes('\n') ? value.slice(value.indexOf('\n') + 1) : '';
    return value;
  } finally {
    await file.close();
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function diagnosticLogLine(line: string): string | undefined {
  if (!/error|fail|timeout|timed out|retry|finish_reason|protocol_error/i.test(line))
    return undefined;
  try {
    const source = record(JSON.parse(line));
    const error = record(source['error'] ?? source['err']);
    const fields = [
      'time',
      'timestamp',
      'level',
      'event',
      'code',
      'statusCode',
      'requestId',
      'traceId',
    ];
    const safe: Record<string, unknown> = {};
    for (const key of fields)
      if (typeof source[key] === 'string' || typeof source[key] === 'number')
        safe[key] = source[key];
    for (const [key, value] of Object.entries({
      message: source['msg'] ?? source['message'],
      errorName: error['name'],
      errorCode: error['code'],
      errorMessage: error['message'],
    }))
      if (typeof value === 'string') safe[key] = value;
    return JSON.stringify(safe);
  } catch {
    return line;
  }
}

function selectedEntries(entries: readonly FeedbackEntry[], turns: number): FeedbackEntry[] {
  if (turns === 0) return [];
  let start = 0;
  let remaining = turns;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.role === 'user' && --remaining === 0) {
      start = i;
      break;
    }
  }
  return entries.slice(start);
}

export function feedbackTranscript(messages: readonly TranscriptMessage[]): FeedbackEntry[] {
  return messages.flatMap<FeedbackEntry>((message) => {
    switch (message.kind) {
      case 'text':
      case 'thinking':
        return [{ role: message.role, kind: message.kind, text: message.text }];
      case 'tool':
        return [
          {
            role: message.role,
            kind: 'tool',
            text: `${message.name}: ${message.summary}\n${message.output ?? ''}`,
          },
        ];
      case 'error':
        return [
          { role: message.role, kind: 'error', text: `${message.summary}\n${message.detail}` },
        ];
      default:
        return [];
    }
  });
}

export async function collectFeedback(input: {
  description: string;
  home?: string;
  turns: 0 | 1 | 3;
  messages?: readonly TranscriptMessage[];
  terminal?: { columns: number; rows: number; mode: string; theme: string };
  sessionId?: string;
  connect?: () => Promise<RuntimeConnection>;
}): Promise<FeedbackBundle> {
  const paths = resolveRuntimePaths(input.home);
  const diagnostics: FeedbackBundle['diagnostics'] = {
    version: VSPI_VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    selectedTurns: input.turns,
    runtime: 'unavailable',
    terminal: process.env.TERM ?? 'unknown',
    colorTerminal: process.env.COLORTERM ?? 'unknown',
    terminalColumns: input.terminal?.columns ?? process.stdout.columns ?? null,
    terminalRows: input.terminal?.rows ?? process.stdout.rows ?? null,
    tuiMode: input.terminal?.mode ?? 'non-interactive',
    theme: input.terminal?.theme ?? 'unknown',
  };
  const secrets = feedbackSecrets(process.env);
  let config: Record<string, unknown> = {};
  let safeSources = true;
  try {
    const raw = await limitedFile(paths.configPath, 1024 * 1024);
    if (raw) {
      config = parse(raw);
      secrets.push(...feedbackSecrets(config));
    }
    const feedbackConfig = await limitedFile(join(paths.homeDir, 'feedback.json'), 16384);
    if (feedbackConfig) secrets.push(...feedbackSecrets(JSON.parse(feedbackConfig)));
    const runtimeToken = await limitedFile(paths.tokenPath, 65536);
    if (runtimeToken?.trim()) secrets.push(runtimeToken.trim());
  } catch {
    diagnostics.configCollection =
      'unavailable; context and logs omitted to avoid credential leakage';
    safeSources = false;
  }
  let entries = input.messages ? feedbackTranscript(input.messages) : [];
  let connection: RuntimeConnection | undefined;
  try {
    connection = await (input.connect ?? (() => connectRuntime(paths.homeDir)))();
    diagnostics.runtime = 'connected';
    diagnostics.runtimeVersion = connection.state.version;
    const providers = await connection.klient.global.config.get('providers');
    const models = await connection.klient.global.config.get('models');
    secrets.push(...feedbackSecrets(providers), ...feedbackSecrets(models));
    if (input.sessionId !== undefined) {
      const agent = connection.klient.session(input.sessionId).agent('main');
      const page = await agent.getHistory({ limit: 200 });
      diagnostics.historyWindowLimited = page.before !== undefined || page.truncated;
      diagnostics.model = page.model ?? 'unknown';
      diagnostics.effort = page.effort;
      const effective = record(record(models)['value'] ?? models);
      const active = record(effective[page.model ?? '']);
      if (typeof active['provider'] === 'string' && typeof active['model'] === 'string') {
        const candidates = (await connection.klient.global.kosong.listModels()).filter(
          (item) => item.provider === active['provider'] && item.model === page.model,
        );
        const protocols = [
          ...new Set(candidates.flatMap((item) => (item.protocol ? [item.protocol] : []))),
        ];
        if (protocols.length === 1) {
          diagnostics.protocol = protocols[0]!;
          diagnostics.protocolSource = 'runtime model catalog';
        }
        const provider = await connection.klient.global.kosong.getProvider(active['provider']);
        const endpoint = active['baseUrl'] ?? provider.base_url;
        if (typeof endpoint === 'string') diagnostics.endpoint = endpoint;
      }
      if (!input.messages && input.turns > 0) {
        entries = page.items.map((item) => {
          const message = record(item);
          const content = Array.isArray(message['content'])
            ? message['content']
                .flatMap((part) => {
                  const p = record(part);
                  return typeof p['text'] === 'string'
                    ? [p['text']]
                    : typeof p['think'] === 'string'
                    ? [p['think']]
                    : [];
                })
                .join('\n')
            : typeof message['content'] === 'string'
            ? message['content']
            : '';
          return {
            role: typeof message['role'] === 'string' ? message['role'] : 'unknown',
            kind: message['role'] === 'tool' ? 'tool' : 'text',
            text: content,
          };
        });
        if (page.live) entries.push({ role: 'assistant', kind: 'text', text: page.live.text });
      }
    }
  } catch {
    diagnostics.runtimeCollection =
      'unavailable or incomplete; no daemon was started or session restored';
  } finally {
    await connection?.close();
  }
  const alias = typeof config['default_model'] === 'string' ? config['default_model'] : undefined;
  const model = record(record(config['models'])[String(diagnostics.model ?? alias ?? '')]);
  const provider = record(record(config['providers'])[typeof model['provider'] === 'string' ? model['provider'] : '']);
  for (const [key, value] of Object.entries({
    configuredModel: model['model'] ?? alias,
    protocol: model['protocol'] ?? model['default_protocol'] ?? provider['type'],
    endpoint: model['base_url'] ?? provider['base_url'],
  }))
    if (typeof value === 'string' && diagnostics[key] === undefined) diagnostics[key] = value;
  entries = safeSources ? selectedEntries(entries, input.turns) : [];
  if (safeSources) {
    try {
      const directory = join(paths.homeDir, 'feedback', 'diagnostics');
      const names = (await readdir(directory)).filter((name) =>
        /^request-errors-[a-f0-9-]{36}\.json$/.test(name),
      );
      const files = await Promise.all(
        names
          .slice(0, 100)
          .map(async (name) => ({ name, time: (await stat(join(directory, name))).mtimeMs })),
      );
      for (const file of files.toSorted((a, b) => b.time - a.time).slice(0, 3)) {
        const content = await limitedFile(join(directory, file.name), 64 * 1024);
        if (content) {
          const records: unknown = JSON.parse(content);
          if (Array.isArray(records))
            for (const item of records.slice(-16))
              entries.push({
                role: 'diagnostic',
                kind: 'request-error-metadata',
                text: JSON.stringify(item),
              });
        }
      }
    } catch {
      diagnostics.requestLogCollection = 'unavailable';
    }
    try {
      const log = await limitedFile(paths.logPath, 64 * 1024, true);
      const errors = log
        ?.split('\n')
        .flatMap((line) => {
          const safe = diagnosticLogLine(line);
          return safe ? [safe] : [];
        })
        .slice(-30)
        .join('\n');
      if (errors) entries.push({ role: 'diagnostic', kind: 'runtime-log-tail', text: errors });
      diagnostics.logTailLimitBytes = 64 * 1024;
    } catch {
      diagnostics.logCollection = 'unavailable';
    }
  }
  return createFeedbackBundle({
    description: input.description,
    diagnostics,
    conversation: entries,
    secrets,
  });
}
