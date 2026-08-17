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

  it("inherits the global Working style when an older project layer omits it", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-settings-working-inheritance-"));
    const home = join(root, "home");
    await saveSettings(root, { ...DEFAULT_SETTINGS, scope: "global", workingStyle: 1 }, home);
    const projectPath = settingsPaths(root, home).project;
    await mkdir(dirname(projectPath), { recursive: true });
    await writeFile(projectPath, `${JSON.stringify({ scope: "project", reducedMotion: true })}\n`);

    const layers = await loadSettingsLayers(root, home, { trustedProject: true });
    expect(layers.global.workingStyle).toBe(1);
    expect(layers.project?.workingStyle).toBe(1);
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
      })}\n`,
    );
    await expect(loadSettings(root, home)).resolves.toMatchObject({
      collapseTools: true,
      workingStyle: 3,
      thinkingTranslationEndpoint: "",
      tuiMode: "regular",
      fullscreenScrollbar: "auto",
      mermaidRendering: "final",
    });
  });

  it("persists valid TUI modes and normalizes invalid fullscreen settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-settings-tui-mode-"));
    const home = join(root, "home");
    const path = settingsPaths(root, home).global;
    await mkdir(dirname(path), { recursive: true });

    await writeFile(
      path,
      `${JSON.stringify({ tuiMode: "regular", fullscreenScrollbar: "hidden", mermaidRendering: "streaming" })}\n`,
    );
    await expect(loadSettings(root, home)).resolves.toMatchObject({
      tuiMode: "regular",
      fullscreenScrollbar: "hidden",
      mermaidRendering: "streaming",
    });

    await writeFile(
      path,
      `${JSON.stringify({ tuiMode: "invalid", fullscreenScrollbar: "wide", mermaidRendering: "sometimes" })}\n`,
    );
    await expect(loadSettings(root, home)).resolves.toMatchObject({
      tuiMode: "regular",
      fullscreenScrollbar: "auto",
      mermaidRendering: "final",
    });
  });

  it("preserves valid Working styles and normalizes missing or invalid values to style 3", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-settings-working-style-"));
    const home = join(root, "home");
    const path = settingsPaths(root, home).global;
    await mkdir(dirname(path), { recursive: true });

    await writeFile(path, `${JSON.stringify({ workingStyle: 1 })}\n`);
    await expect(loadSettings(root, home)).resolves.toMatchObject({ workingStyle: 1 });

    await writeFile(path, `${JSON.stringify({ workingStyle: 4 })}\n`);
    await expect(loadSettings(root, home)).resolves.toMatchObject({ workingStyle: 3 });
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
