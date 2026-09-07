import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const packages = ['@moonshot-ai/agent-core-v2', '@moonshot-ai/klient', '@moonshot-ai/kap-server', '@vsp/vsp-runtime', 'vspi'];
const packageManager = process.env.npm_execpath;

async function run(args) {
  const child = packageManager
    ? spawn(process.execPath, [packageManager, ...args], { cwd, stdio: 'inherit' })
    : spawn('pnpm', args, { cwd, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => signal ? reject(new Error(`Validation terminated: ${signal}`)) : resolve(code));
  });
  if (code !== 0) throw new Error(`Validation failed (${String(code)}): pnpm ${args.join(' ')}`);
}

await run(['lint']);
await run(['sherif']);
for (const pkg of packages) {
  await run(['--filter', pkg, 'typecheck']);
  await run(['--filter', pkg, 'test', '--maxWorkers=4']);
}
await run(['--filter', '@moonshot-ai/agent-core-v2', 'lint:imports']);
