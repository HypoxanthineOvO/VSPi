import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings, saveSettings, settingsPaths } from "../src/config/settings.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";

describe("settings persistence", () => {
  it("applies project settings over global settings and writes atomically with private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-settings-"));
    const home = await mkdtemp(join(tmpdir(), "vspi-home-"));
    await saveSettings(root, { ...DEFAULT_SETTINGS, scope: "global", reducedMotion: true }, home);
    const projectPath = await saveSettings(root, { ...DEFAULT_SETTINGS, scope: "project", wrapCode: true }, home, {
      trustedProject: true,
    });
    const loaded = await loadSettings(root, home, { trustedProject: true });
    expect(loaded.scope).toBe("project");
    expect(loaded.wrapCode).toBe(true);
    expect(settingsPaths(root, home).project).toBe(projectPath);
    expect((await stat(projectPath)).mode & 0o777).toBe(0o600);
  });
});
