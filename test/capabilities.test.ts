import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";
import { applySettingsToCapabilities, detectTerminalCapabilities } from "../src/ui/capabilities.js";
import { capabilities } from "./helpers.js";

describe("terminal capability detection", () => {
  it("detects truecolor, unicode, SSH and reduced motion", () => {
    expect(
      detectTerminalCapabilities({
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: "zh_CN.UTF-8",
        SSH_CONNECTION: "local remote",
        VSPi_REDUCED_MOTION: "1",
      }),
    ).toEqual({ colorLevel: 3, truecolor: true, unicode: true, reducedMotion: true, ssh: true });
  });

  it("fails down to plain ASCII for a dumb terminal", () => {
    const result = detectTerminalCapabilities({ TERM: "dumb", LANG: "C" });
    expect(result.colorLevel).toBe(0);
    expect(result.unicode).toBe(false);
    expect(result.reducedMotion).toBe(true);
  });

  it("combines terminal and persisted reduced-motion preferences without disabling either", () => {
    const terminalReduced = capabilities({ reducedMotion: true, truecolor: true });
    expect(applySettingsToCapabilities(terminalReduced, { ...DEFAULT_SETTINGS, reducedMotion: false })).toEqual(
      terminalReduced,
    );

    const settingsReduced = capabilities({ reducedMotion: false, ssh: true });
    expect(applySettingsToCapabilities(settingsReduced, { ...DEFAULT_SETTINGS, reducedMotion: true })).toEqual({
      ...settingsReduced,
      reducedMotion: true,
    });
  });
});
