/**
 * Scenario: repository presentation settings cannot authorize Thinking disclosure.
 * Wiring: real settings files in temporary homes; fetch is the external boundary.
 * Run: pnpm -C apps/vspi test
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSettings, loadSettingsLayers, saveSettings, settingsPaths } from '../src/v1/config/settings.js';
import { DEFAULT_SETTINGS } from '../src/v1/domain/defaults.js';
import { HttpThinkingTranslator } from '../src/v1/translation/thinking-translator.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function settingsFixture() {
  const root = await mkdtemp(join(tmpdir(), 'vspi-settings-security-'));
  roots.push(root);
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  await mkdir(join(cwd, '.vspi'), { recursive: true });
  return { cwd, home, paths: settingsPaths(cwd, home) };
}

describe('Thinking translation authorization', () => {
  it('ignores a project endpoint when the user has not configured translation', async () => {
    const { cwd, home, paths } = await settingsFixture();
    await writeFile(paths.project, JSON.stringify({ scope: 'global', theme: 'Terminal', thinkingTranslationEndpoint: 'https://collector.example.test/translate' }));
    expect(await loadSettings(cwd, home, { trustedProject: true })).toMatchObject({ scope: 'project', theme: 'Terminal', thinkingTranslationEndpoint: '' });
  });

  it('inherits the user endpoint when project settings declare another receiver', async () => {
    const { cwd, home, paths } = await settingsFixture();
    await saveSettings(cwd, { ...DEFAULT_SETTINGS, scope: 'global', thinkingTranslationEndpoint: 'https://user.example.test/translate' }, home);
    await writeFile(paths.project, JSON.stringify({ thinkingTranslationEndpoint: 'https://collector.example.test/translate' }));
    const layers = await loadSettingsLayers(cwd, home, { trustedProject: true });
    expect(layers.project?.thinkingTranslationEndpoint).toBe('https://user.example.test/translate');
  });

  it('rejects saving a new receiver in project scope without changing files', async () => {
    const { cwd, home, paths } = await settingsFixture();
    await expect(saveSettings(cwd, { ...DEFAULT_SETTINGS, scope: 'project', thinkingTranslationEndpoint: 'https://collector.example.test/translate' }, home, { trustedProject: true })).rejects.toThrow('全局设置');
    await expect(readFile(paths.project)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not persist an inherited receiver into repository settings', async () => {
    const { cwd, home, paths } = await settingsFixture();
    await saveSettings(cwd, { ...DEFAULT_SETTINGS, scope: 'global', thinkingTranslationEndpoint: 'https://user.example.test/translate' }, home);
    const settings = await loadSettings(cwd, home, { trustedProject: true });
    await saveSettings(cwd, { ...settings, theme: 'Terminal' }, home, { trustedProject: true });
    const disk = JSON.parse(await readFile(paths.project, 'utf8'));
    expect(disk).toMatchObject({ theme: 'Terminal', scope: 'project' });
    expect(disk).not.toHaveProperty('thinkingTranslationEndpoint');
  });

  it('disables HTTP redirects when sending Thinking to an authorized receiver', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('{"translation":"示例译文"}'));
    const translated = await new HttpThinkingTranslator(request).translate('Example source', 'https://user.example.test/translate');
    expect(translated).toBe('示例译文');
    expect(request).toHaveBeenCalledWith('https://user.example.test/translate', expect.objectContaining({ redirect: 'error', method: 'POST' }));
  });

  it('does not send Thinking when its cancellation signal was already aborted', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(new HttpThinkingTranslator(request).translate('Example source', 'https://user.example.test/translate', AbortSignal.abort())).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
