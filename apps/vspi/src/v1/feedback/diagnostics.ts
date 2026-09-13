import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { redactFeedbackText } from './bundle.js';

export function errorDiagnostic(value: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  for (let depth = 0; depth < 8 && value && typeof value === 'object'; depth++) {
    const source = value as Record<string, unknown>;
    const details =
      source.details && typeof source.details === 'object'
        ? (source.details as Record<string, unknown>)
        : {};
    const item: Record<string, unknown> = {};
    for (const key of ['code', 'name'])
      if (typeof source[key] === 'string')
        item[key] = redactFeedbackText(source[key]).slice(0, 120);
    for (const key of [
      'expectedProtocol',
      'observedFormat',
      'contentType',
      'transportCode',
      'requestId',
      'traceId',
      'statusCode',
      'bytesReceived',
      'sampledBytes',
      'sampleLimitBytes',
      'firstByteMs',
      'lastByteMs',
    ]) {
      const field = details[key];
      if (typeof field === 'string') item[key] = redactFeedbackText(field).slice(0, 160);
      else if (typeof field === 'number' && Number.isFinite(field)) item[key] = field;
    }
    if (Object.keys(item).length > 0) chain.push(item);
    value = source.cause;
  }
  return chain;
}

export class FeedbackDiagnosticLog {
  private readonly filename = `request-errors-${randomUUID()}.json`;
  private entries: object[] = [];
  private pending = false;
  private writing = false;
  private operation: Promise<void> | undefined;
  constructor(private readonly home: string) {}
  append(error: unknown, model: string): void {
    this.entries = [
      ...this.entries.slice(-31),
      {
        time: new Date().toISOString(),
        model: redactFeedbackText(model).slice(0, 160),
        chain: errorDiagnostic(error),
      },
    ];
    this.pending = true;
    if (!this.writing) this.operation = this.flush();
  }
  async drain(): Promise<void> {
    await this.operation;
  }
  private async flush(): Promise<void> {
    this.writing = true;
    const directory = join(this.home, 'feedback', 'diagnostics');
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      while (this.pending) {
        this.pending = false;
        const candidates = (await readdir(directory)).filter((name) =>
          /^request-errors-[a-f0-9-]{36}\.json$/.test(name),
        );
        const files = await Promise.all(
          candidates.map(async (name) => ({
            name,
            time: (await stat(join(directory, name))).mtimeMs,
          })),
        );
        for (const file of files
          .filter((file) => file.name !== this.filename)
          .toSorted((a, b) => b.time - a.time)
          .slice(19))
          await rm(join(directory, file.name), { force: true });
        while (
          Buffer.byteLength(JSON.stringify(this.entries)) > 64 * 1024 &&
          this.entries.length > 1
        )
          this.entries.shift();
        const temporary = join(directory, `${this.filename}.${randomUUID()}.tmp`);
        let created = false;
        try {
          const file = await open(temporary, 'wx', 0o600);
          created = true;
          try { await file.writeFile(JSON.stringify(this.entries)); } finally { await file.close(); }
          await rename(temporary, join(directory, this.filename));
        } finally { if (created) await rm(temporary, { force: true }); }
      }
    } catch {
    } finally {
      this.writing = false;
    }
  }
}
