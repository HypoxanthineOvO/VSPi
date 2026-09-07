import type { TUI } from "@moonshot-ai/pi-tui";
import { runStartupSequence, type StartupStatus } from "../ui/splash.js";
import type { VspiTheme } from "../ui/theme.js";

export type { StartupStatus } from "../ui/splash.js";

export async function startUiAfterSplash(options: {
  width: number;
  theme: VspiTheme;
  write: (chunk: string) => void;
  startApp: () => Promise<StartupStatus> | StartupStatus;
  startTui: (startupSurface: readonly string[]) => Promise<void> | void;
}): Promise<void> {
  await runStartupSequence({
    width: options.width,
    getWidth: () => process.stdout.columns || options.width,
    theme: options.theme,
    write: options.write,
    startApp: options.startApp,
    startTui: options.startTui,
  });
}

export async function shutdownInteractiveSession(options: {
  disposeApp: () => Promise<void>;
  tui: Pick<TUI, "stop" | "pauseRendering">;
  drainInput: () => Promise<void>;
  prepareShutdown?: () => void;
  disposeTimeoutMs?: number;
}): Promise<void> {
  const errors: unknown[] = [];
  try {
    options.tui.pauseRendering?.();
    options.prepareShutdown?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    await options.drainInput();
  } catch (error) {
    errors.push(error);
  }
  try {
    options.tui.stop();
  } catch (error) {
    errors.push(error);
  }
  const disposeTimeoutMs = options.disposeTimeoutMs ?? 10_000;
  let disposeTimer: NodeJS.Timeout | undefined;
  const dispose = Promise.resolve()
    .then(options.disposeApp)
    .catch((error) => {
      errors.push(error);
    });
  const disposeTimeout = new Promise<void>((resolve) => {
    disposeTimer = setTimeout(resolve, disposeTimeoutMs);
    disposeTimer.unref?.();
  });
  await Promise.race([dispose, disposeTimeout]);
  if (disposeTimer) clearTimeout(disposeTimer);

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Interactive session shutdown failed");
}
