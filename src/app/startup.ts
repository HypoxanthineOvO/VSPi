import type { TUI } from "@earendil-works/pi-tui";
import { runStartupSequence, type StartupStatus } from "../ui/splash.js";
import type { VspiTheme } from "../ui/theme.js";

export type { StartupStatus } from "../ui/splash.js";

export async function startUiAfterSplash(options: {
  width: number;
  theme: VspiTheme;
  write: (chunk: string) => void;
  commitStatic?: (lines: readonly string[]) => void;
  startApp: () => Promise<StartupStatus> | StartupStatus;
  startTui: () => Promise<void> | void;
}): Promise<void> {
  await runStartupSequence({
    width: options.width,
    getWidth: () => process.stdout.columns || options.width,
    theme: options.theme,
    write: options.write,
    ...(options.commitStatic ? { commitStatic: options.commitStatic } : {}),
    startApp: options.startApp,
    startTui: options.startTui,
  });
}

export async function shutdownInteractiveSession(options: {
  disposeApp: () => Promise<void>;
  tui: Pick<TUI, "stop">;
  drainInput: () => Promise<void>;
}): Promise<void> {
  const errors: unknown[] = [];
  try {
    await options.disposeApp();
  } catch (error) {
    errors.push(error);
  }
  try {
    options.tui.stop();
  } catch (error) {
    errors.push(error);
  }
  try {
    await options.drainInput();
  } catch (error) {
    errors.push(error);
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Interactive session shutdown failed");
}
