import { spawn, spawnSync } from "node:child_process";

export interface ClipboardImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface CommandResult {
  ok: boolean;
  stdout: Buffer;
}

export type ClipboardCommandRunner = (command: string, args: string[], timeout?: number) => CommandResult;

export interface ClipboardWriteOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  writeTerminal?: (sequence: string) => void;
  run?: (command: string, args: string[], input?: Buffer) => Promise<CommandResult>;
}

export function clipboardSequence(text: string, tmux = false): string {
  if (Buffer.byteLength(text, 'utf8') > 100_000) throw new Error('终端复制内容超过 100 KB；请缩小复制范围');
  const sequence = `\u001B]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;
  return tmux ? `\u001BPtmux;${sequence.replaceAll('\u001B', '\u001B\u001B')}\u001B\\` : sequence;
}

export async function writeClipboardText(text: string, options: ClipboardWriteOptions = {}): Promise<string> {
  if (!text) throw new Error('没有可复制的内容');
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const execute = options.run ?? ((command, args, input) => runClipboardCommand(command, args, input, env));
  const tmux = [env.TMUX, env.TMUX_PANE].some(Boolean);
  const ssh = [env.SSH_TTY, env.SSH_CONNECTION, env.SSH_CLIENT].some(Boolean);
  if (!ssh) {
    const input = Buffer.from(text, 'utf8');
    const commands: Array<[string, string[]]> = [];
    if (platform === 'darwin') commands.push(['pbcopy', []]);
    if (platform === 'linux' && !env.TERMUX_VERSION) {
      if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === 'wayland') commands.push(['wl-copy', []]);
      if (env.DISPLAY) commands.push(['xclip', ['-selection', 'clipboard']]);
    }
    if (platform === 'win32' || env.WSL_DISTRO_NAME || env.WSL_INTEROP) commands.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())']]);
    for (const [command, args] of commands) if ((await execute(command, args, input)).ok) return '已复制到系统剪贴板';
  }
  const sequence = clipboardSequence(text, tmux);
  if (tmux) {
    const config = await execute('tmux', ['show-options', '-gv', 'set-clipboard']);
    if (config.ok && ['on', 'external'].includes(config.stdout.toString().trim())) {
      const capabilities = await execute('tmux', ['info']);
      if (capabilities.ok && /Ms:\s*\(string\)/u.test(capabilities.stdout.toString()) &&
        (await execute('tmux', ['load-buffer', '-w', '-'], Buffer.from(text, 'utf8'))).ok) return '已请求终端复制；若未生效，请检查终端剪贴板权限';
    }
  }
  const writeTerminal = options.writeTerminal ?? (process.stdout.isTTY ? (value: string) => { process.stdout.write(value); } : undefined);
  if (!writeTerminal) throw new Error('系统剪贴板不可用，且当前没有可写入的交互终端');
  try { writeTerminal(sequence); }
  catch { throw new Error('无法发送终端剪贴板请求，请检查终端连接'); }
  return '已请求终端复制；若未生效，请检查终端剪贴板权限';
}

function runClipboardCommand(command: string, args: string[], input: Buffer | undefined, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false });
    let output = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve({ ok, stdout: output });
    };
    const timer = setTimeout(() => {
      timedOut = true; child.kill('SIGKILL'); child.stdout.destroy(); child.stdin.destroy();
      finish(false);
    }, 1500);
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > 64 * 1024) { timedOut = true; child.kill('SIGKILL'); }
      else output = Buffer.concat([output, chunk]);
    });
    child.stdin.on('error', () => {});
    child.once('error', () => { finish(false); });
    child.once('close', code => { finish(!timedOut && code === 0); });
    child.stdin.end(input);
  });
}

function run(command: string, args: string[], timeout = 3000): CommandResult {
  const result = spawnSync(command, args, { timeout, maxBuffer: 25 * 1024 * 1024, windowsHide: true, shell: false });
  if (result.error || result.status !== 0) return { ok: false, stdout: Buffer.alloc(0) };
  return { ok: true, stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "") };
}

function preferred(types: string[]): string | undefined {
  const supported = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  return supported.find((mime) => types.some((type) => type.split(";", 1)[0]?.trim().toLowerCase() === mime));
}

function readWayland(runner: ClipboardCommandRunner): ClipboardImage | undefined {
  const types = runner("wl-paste", ["--list-types"], 1000);
  if (!types.ok || types.stdout.length > 64 * 1024) return undefined;
  const mimeType = preferred(types.stdout.toString("utf8").split(/\r?\n/));
  if (!mimeType) return undefined;
  const image = runner("wl-paste", ["--type", mimeType, "--no-newline"]);
  return validImage(image, mimeType);
}

function readX11(runner: ClipboardCommandRunner): ClipboardImage | undefined {
  const targets = runner("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], 1000);
  const types = targets.ok && targets.stdout.length <= 64 * 1024 ? targets.stdout.toString("utf8").split(/\r?\n/) : [];
  const ordered = [preferred(types), "image/png", "image/jpeg", "image/webp", "image/gif"].filter(
    (value, index, array): value is string => Boolean(value) && array.indexOf(value) === index,
  );
  for (const mimeType of ordered) {
    const image = runner("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
    const valid = validImage(image, mimeType);
    if (valid) return valid;
  }
  return undefined;
}

function readMac(runner: ClipboardCommandRunner): ClipboardImage | undefined {
  const image = runner("pngpaste", ["-"], undefined);
  return validImage(image, "image/png");
}

function validImage(result: CommandResult, mimeType: string): ClipboardImage | undefined {
  return result.ok && result.stdout.length > 0 && result.stdout.length <= 20 * 1024 * 1024
    ? { bytes: result.stdout, mimeType }
    : undefined;
}

export async function readClipboardImage(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClipboardImage | undefined> {
  return readClipboardImageWithRunner({ platform, env, run });
}

export async function readClipboardImageWithRunner(options: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  run: ClipboardCommandRunner;
}): Promise<ClipboardImage | undefined> {
  const { platform, env, run: runner } = options;
  if (env.TERMUX_VERSION) return undefined;
  if (platform === "darwin") return readMac(runner);
  if (platform !== "linux") return undefined;
  if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland") return readWayland(runner) ?? readX11(runner);
  return readX11(runner) ?? readWayland(runner);
}
