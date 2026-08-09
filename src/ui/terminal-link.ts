import { spawn } from "node:child_process";

const MAX_LINK_LENGTH = 8_192;

export function isOpenableTerminalUrl(target: string): boolean {
  if (target.length === 0 || target.length > MAX_LINK_LENGTH) return false;
  try {
    const protocol = new URL(target).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Open a user-clicked Markdown link without passing model-controlled text through a shell. */
export function openTerminalUrl(target: string): boolean {
  if (!isOpenableTerminalUrl(target)) return false;
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", target]]
        : ["xdg-open", [target]];
  spawn(command, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
  return true;
}
