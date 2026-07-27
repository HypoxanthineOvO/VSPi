import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings, loadSettingsLayers, saveSettings, settingsPaths } from "../src/config/settings.js";
import { DEFAULT_SETTINGS } from "../src/domain/fixtures.js";

describe("settings persistence", () => {
  it("exposes Global and Project as separate editable layers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-settings-layers-"));
    const home = join(root, "home");
    await saveSettings(root, { ...DEFAULT_SETTINGS, scope: "global", reducedMotion: false }, home, {
      trustedProject: true,
    });
    await saveSettings(root, { ...DEFAULT_SETTINGS, scope: "project", reducedMotion: true }, home, {
      trustedProject: true,
    });
    const layers = await loadSettingsLayers(root, home, { trustedProject: true });
    expect(layers.global).toMatchObject({ scope: "global", reducedMotion: false });
    expect(layers.project).toMatchObject({ scope: "project", reducedMotion: true });
    expect(layers.projectInherited).toBe(false);
  });

  it("applies project settings over global settings and writes atomically with private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-settings-"));
    const home = await mkdtemp(join(tmpdir(), "vspi-home-"));
    await saveSettings(root, { ...DEFAULT_SETTINGS, scope: "global", reducedMotion: true }, home);
    const projectPath = await saveSettings(
      root,
      {
        ...DEFAULT_SETTINGS,
        scope: "project",
        wrapCode: true,
        thinkingTranslationEndpoint: "http://127.0.0.1:5000/translate",
      },
      home,
      { trustedProject: true },
    );
    const loaded = await loadSettings(root, home, { trustedProject: true });
    expect(loaded.scope).toBe("project");
    expect(loaded.wrapCode).toBe(true);
    expect(loaded.thinkingTranslationEndpoint).toBe("http://127.0.0.1:5000/translate");
    expect(settingsPaths(root, home).project).toBe(projectPath);
    expect((await stat(projectPath)).mode & 0o777).toBe(0o600);
  });

  it("defaults completed-tool collapse on when loading an older settings file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-settings-legacy-"));
    const home = join(root, "home");
    const path = settingsPaths(root, home).global;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({
        scope: "global",
        theme: "VSPi Dark",
        reducedMotion: false,
        showThinking: true,
        wrapCode: false,
        bridgeEnabled: true,
      })}\n`,
    );
    await expect(loadSettings(root, home)).resolves.toMatchObject({
      collapseTools: true,
      thinkingTranslationEndpoint: "",
    });
  });

  it("migrates legacy thinking booleans and gives the new enum precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-settings-thinking-migration-"));
    const home = join(root, "home");
    const path = settingsPaths(root, home).global;
    await mkdir(dirname(path), { recursive: true });

    await writeFile(path, `${JSON.stringify({ showThinking: false })}\n`);
    await expect(loadSettings(root, home)).resolves.toMatchObject({ thinkingDisplay: "hidden" });

    await writeFile(path, `${JSON.stringify({ showThinking: true })}\n`);
    await expect(loadSettings(root, home)).resolves.toMatchObject({ thinkingDisplay: "collapsed" });

    await writeFile(path, `${JSON.stringify({ thinkingDisplay: "expanded", showThinking: false })}\n`);
    await expect(loadSettings(root, home)).resolves.toMatchObject({ thinkingDisplay: "expanded" });
  });
});
