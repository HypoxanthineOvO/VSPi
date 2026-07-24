import { spawnSync } from "node:child_process";

export interface ClipboardImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface CommandResult {
  ok: boolean;
  stdout: Buffer;
}

export type ClipboardCommandRunner = (command: string, args: string[], timeout?: number) => CommandResult;

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
