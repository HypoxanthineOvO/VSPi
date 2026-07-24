import type { AppSettings } from "../domain/types.js";

export type ColorLevel = 0 | 1 | 2 | 3;

export interface TerminalCapabilities {
  colorLevel: ColorLevel;
  truecolor: boolean;
  unicode: boolean;
  reducedMotion: boolean;
  ssh: boolean;
}

export function detectTerminalCapabilities(env: NodeJS.ProcessEnv = process.env): TerminalCapabilities {
  const term = env.TERM ?? "";
  const colorTerm = env.COLORTERM?.toLowerCase() ?? "";
  const noColor = env.NO_COLOR !== undefined || term === "dumb";
  const truecolor = !noColor && (colorTerm.includes("truecolor") || colorTerm.includes("24bit"));
  const color256 = !noColor && (truecolor || term.includes("256color"));
  const colorLevel: ColorLevel = noColor ? 0 : truecolor ? 3 : color256 ? 2 : 1;
  const locale = `${env.LC_ALL ?? ""}${env.LC_CTYPE ?? ""}${env.LANG ?? ""}`.toLowerCase();
  const unicode =
    term !== "dumb" && (locale.includes("utf-8") || locale.includes("utf8") || process.platform === "win32");

  return {
    colorLevel,
    truecolor,
    unicode,
    reducedMotion: env.VSPi_REDUCED_MOTION === "1" || env.REDUCE_MOTION === "1" || term === "dumb",
    ssh: Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT),
  };
}

export function applySettingsToCapabilities(
  capabilities: TerminalCapabilities,
  settings: AppSettings,
): TerminalCapabilities {
  return {
    ...capabilities,
    reducedMotion: capabilities.reducedMotion || settings.reducedMotion,
  };
}
