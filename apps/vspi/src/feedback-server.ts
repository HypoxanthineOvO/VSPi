import { open } from 'node:fs/promises';
import { createFeedbackServer } from './v1/feedback/server.js';

const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node feedback-server.mjs /etc/vsp-feedback/server.json');
type Config = {
  directory: string;
  host?: string;
  port: number;
  submitters: Array<{ id: string; token: string }>;
};
async function readConfig(): Promise<Config> {
  const file = await open(configPath!, 'r');
  try {
    if ((await file.stat()).size > 128 * 1024)
      throw new Error('Feedback configuration exceeds limit');
    try {
      return JSON.parse(await file.readFile('utf8')) as Config;
    } catch {
      throw new Error('Invalid feedback configuration JSON');
    }
  } finally {
    await file.close();
  }
}
const config = await readConfig();
if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535)
  throw new Error('Configure an unprivileged listening port');
const server = await createFeedbackServer(config);
server.listen(config.port, config.host ?? '127.0.0.1');
let reloadPending = false;
let reloading = false;
process.on('SIGHUP', () => {
  reloadPending = true;
  if (reloading) return;
  reloading = true;
  void (async () => {
    while (reloadPending) {
      reloadPending = false;
      try {
        const next = await readConfig();
        server.reloadSubmitters(next.submitters);
      } catch {
        process.stderr.write(
          'Feedback credential reload rejected; previous configuration retained.\n',
        );
      }
    }
  })().finally(() => {
    reloading = false;
  });
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.close();
    server.closeIdleConnections();
  });
