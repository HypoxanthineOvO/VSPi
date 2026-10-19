/**
 * Shared conformance suite — the guarantee that the ipc and memory
 * transports are interchangeable. Every transport test file runs the exact
 * same assertions against a real in-process engine; only the `before` setup
 * differs per file.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Service } from '@moonshot-ai/agent-core-v2/_base/di/service';
import { overrideScopedService, ScopeActivation } from '@moonshot-ai/agent-core-v2/_base/di/scope';
import { LifecycleScope } from '@moonshot-ai/agent-core-v2/app/scopes';
import { CommandContribution } from '@moonshot-ai/agent-core-v2/agent/command/commandContribution';
import { IFeatureManager } from '@moonshot-ai/agent-core-v2/app/feature/featureManager';
import {
  resetModelsDevUpstreamForTest,
  setModelsDevUpstreamForTest,
} from '@moonshot-ai/agent-core-v2/app/kosongConfig/modelsDevUpstream';
import type {
  CreateTerminalRequest,
  Terminal,
  TerminalAttachOptions,
  TerminalAttachSink,
} from '@moonshot-ai/agent-core-v2/os/interface/terminal';
import {
  ISessionTerminalService,
  type TerminalStreamFrame,
} from '@moonshot-ai/agent-core-v2/session/terminal/terminalService';
import { ISessionManager } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionManager';
import { getLiveSessionById } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionLookup';
import { IAgentLifecycleService } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/mainAgent';
import { IAgentGoalService } from '@moonshot-ai/agent-core-v2/features/goal/goalService';

import type { Klient } from '../../src/index.js';
import type { ScopeRef } from '../../src/core/channel.js';
import { KlientValidationError } from '../../src/core/validation.js';
import type { TestEngine } from './engine.js';

const CONFORMANCE_TERMINAL: Terminal = {
  id: 'conf-term',
  session_id: 'conf-session',
  cwd: '/conf',
  shell: '/bin/sh',
  cols: 100,
  rows: 30,
  status: 'running',
  created_at: new Date(0).toISOString(),
};

class ConformanceTerminalService implements ISessionTerminalService {
  declare readonly _serviceBrand: undefined;
  static readonly instances: ConformanceTerminalService[] = [];
  readonly opened: CreateTerminalRequest[] = [];
  readonly writes: Array<{ id: string; data: string }> = [];
  readonly resizes: Array<{ id: string; cols: number; rows: number }> = [];
  readonly closedIds: string[] = [];

  constructor() {
    ConformanceTerminalService.instances.push(this);
  }

  open(input: CreateTerminalRequest): AsyncIterable<TerminalStreamFrame> {
    this.opened.push(input);
    const frames: TerminalStreamFrame[] = [
      { type: 'terminal_ready', terminal: CONFORMANCE_TERMINAL },
      {
        type: 'terminal_output',
        seq: 1,
        session_id: 'conf-session',
        terminal_id: 'conf-term',
        timestamp: new Date(0).toISOString(),
        payload: { data: 'conf-ok' },
      },
    ];
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            const frame = frames[index];
            index += 1;
            return frame === undefined
              ? { done: true as const, value: undefined }
              : { done: false as const, value: frame };
          },
          async return() {
            return { done: true as const, value: undefined };
          },
        };
      },
    };
  }

  async create(input: CreateTerminalRequest): Promise<Terminal> {
    this.opened.push(input);
    return CONFORMANCE_TERMINAL;
  }

  async list(): Promise<readonly Terminal[]> {
    return [CONFORMANCE_TERMINAL];
  }

  async get(terminalId: string): Promise<Terminal> {
    return { ...CONFORMANCE_TERMINAL, id: terminalId };
  }

  async attach(
    _terminalId: string,
    _sink: TerminalAttachSink,
    _options?: TerminalAttachOptions,
  ): Promise<{ replayed: number }> {
    return { replayed: 0 };
  }

  detach(): void {}
  detachAllForSink(): void {}

  async write(terminalId: string, data: string): Promise<void> {
    this.writes.push({ id: terminalId, data });
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    this.resizes.push({ id: terminalId, cols, rows });
  }

  async close(terminalId: string): Promise<{ closed: true }> {
    this.closedIds.push(terminalId);
    return { closed: true };
  }
}

overrideScopedService(
  LifecycleScope.Session,
  ISessionTerminalService,
  ConformanceTerminalService,
  ScopeActivation.OnDemand,
  'conformance-terminal',
);

export interface KlientConformanceTarget {
  readonly klient: Klient;
  /**
   * The in-process engine's App scope. Both transports boot the engine
   * in-process, so the suite can assemble dynamic units (e.g. contributed
   * commands) through the production `IFeatureManager` path.
   */
  readonly app: TestEngine['app'];
  rawCall(
    service: string,
    method: string,
    args: unknown[],
    scope?: ScopeRef,
  ): Promise<unknown>;
  cleanup(): Promise<void>;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

export function defineKlientConformance(
  transport: string,
  makeTarget: () => Promise<KlientConformanceTarget>,
): void {
  describe(`klient conformance: ${transport}`, () => {
    let target: KlientConformanceTarget;

    beforeAll(async () => {
      target = await makeTarget();
    });

    afterAll(async () => {
      await target.cleanup();
    });

    it('env() aggregates the host snapshot', async () => {
      const env = await target.klient.global.env();
      expect(env.platform).toBe(process.platform);
      expect(env.homeDir.length).toBeGreaterThan(0);
      expect(env.clientVersion.length).toBeGreaterThan(0);
    });

    it('reads the effective permission mode after changing it', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'klient-permission-'));
      await mkdir(join(workDir, '.git'));
      const created = await target.klient.global.sessions.create({ workDir, title: 'permission conformance' });
      try {
        const agent = target.klient.session(created.id).agent('main');
        await agent.setPermission('auto');
        expect(await agent.getPermission()).toBe('auto');
        await agent.setPermission('manual');
        expect(await agent.getPermission()).toBe('manual');
      } finally {
        await target.klient.session(created.id).close();
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('publishes permission changes through the typed event surface', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'klient-permission-events-'));
      await mkdir(join(workDir, '.git'));
      const created = await target.klient.global.sessions.create({ workDir, title: 'permission events' });
      const agent = target.klient.session(created.id).agent('main');
      const events: Array<{ mode: string; previousMode: string }> = [];
      await agent.setPermission('auto');
      const subscription = agent.events.on('permission.mode.changed', (event) => { events.push(event); });
      try {
        await agent.getPermission();
        await agent.setPermission('manual');
        await vi.waitFor(() => expect(events).toContainEqual({ mode: 'manual', previousMode: 'auto' }));
      } finally {
        subscription.dispose();
        await target.klient.session(created.id).close();
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('starts a side question as a separate agent in the same session', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'klient-side-question-'));
      await mkdir(join(workDir, '.git'));
      const created = await target.klient.global.sessions.create({ workDir, title: 'side question' });
      const session = target.klient.session(created.id);
      try {
        const agentId = await session.startSideQuestion();
        expect(agentId).not.toBe('main');
        expect(agentId.length).toBeGreaterThan(0);
        expect(await session.agents()).toHaveProperty(agentId);
        await session.closeSideQuestion(agentId);
        expect((await session.agent('main').getActivity()).turn).toBeUndefined();
      } finally {
        await session.close();
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('workspaces round-trip through create/get/update/list/delete', async () => {
      const workspaces = target.klient.global.workspaces;
      const created = await workspaces.createOrTouch({ root: process.cwd(), name: 'conformance' });
      expect(created.id.length).toBeGreaterThan(0);

      const fetched = await workspaces.get(created.id);
      expect(fetched?.name).toBe('conformance');

      const updated = await workspaces.update({ id: created.id, patch: { name: 'conformance-2' } });
      expect(updated?.name).toBe('conformance-2');

      const list = await workspaces.list();
      expect(list.some((w) => w.id === created.id)).toBe(true);

      await workspaces.delete(created.id);
      expect(await workspaces.get(created.id)).toBeUndefined();
    });

    it('sessions index responds with a page shape', async () => {
      const page = await target.klient.global.sessions.list({});
      expect(Array.isArray(page.items)).toBe(true);
      const count = await target.klient.global.sessions.countActive(['no-such-workspace']);
      expect(typeof count).toBe('number');
    });

    it('creates a titled session through implicit workspace materialization', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance session',
      });

      try {
        expect(created).toMatchObject({
          title: 'conformance session',
          cwd: process.cwd(),
          archived: false,
        });
        expect(created.id.length).toBeGreaterThan(0);
        expect(await target.klient.global.sessions.get(created.id)).toMatchObject({
          id: created.id,
          title: 'conformance session',
        });
      } finally {
        await target.klient.session(created.id).close();
      }
    });

    it('session createChild tags child markers while fork stays untagged', async () => {
      const parent = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance parent',
      });
      try {
        const child = await target.klient.session(parent.id).createChild();
        try {
          expect(child.custom?.['parent_session_id']).toBe(parent.id);
          expect(child.custom?.['child_session_kind']).toBe('child');
          expect(child.title).toBe('Child: conformance parent');
        } finally {
          await target.klient.session(child.id).close();
        }
        const forked = await target.klient.session(parent.id).fork();
        try {
          expect(forked.custom?.['parent_session_id']).toBeUndefined();
          expect(forked.custom?.['child_session_kind']).toBeUndefined();
        } finally {
          await target.klient.session(forked.id).close();
        }
      } finally {
        await target.klient.session(parent.id).close();
      }
    });

    it('session skills load and watch reload stay inside the fixture project boundary', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'klient-conf-skills-'));
      const skillDir = join(workDir, '.kimi-code', 'skills', 'conf-skill');
      const skillFile = join(skillDir, 'SKILL.md');
      try {
        await mkdir(join(workDir, '.git'));
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          skillFile,
          '---\nname: conf-skill\ndescription: conformance fixture skill\n---\n\n# Conf\n',
        );
        const created = await target.klient.global.sessions.create({ workDir });
        try {
          const session = target.klient.session(created.id);
          const skills = await session.skills.list();
          expect(skills.find((skill) => skill.name === 'conf-skill')).toMatchObject({
            name: 'conf-skill',
            description: 'conformance fixture skill',
            path: skillFile,
            source: 'project',
          });

          const reloaded = new Promise<string>((resolve) => {
            const subscription = session.events.on('skills.changed', (sourceId) => {
              if (sourceId === 'workspace') {
                subscription.dispose();
                resolve(sourceId);
              }
            });
          });
          await session.skills.list();
          await writeFile(
            skillFile,
            '---\nname: conf-skill\ndescription: reloaded fixture skill\n---\n\n# Conf\n',
          );

          await expect(reloaded).resolves.toBe('workspace');
          expect((await session.skills.list()).find((skill) => skill.name === 'conf-skill')).toMatchObject({
            description: 'reloaded fixture skill',
            path: skillFile,
            source: 'project',
          });
        } finally {
          await target.klient.session(created.id).close();
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('promptWithSkills submits skills, args, and steerIfActive on every transport', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'klient-conf-skill-submit-'));
      try {
        await mkdir(join(workDir, '.git'), { recursive: true });
        await mkdir(join(workDir, '.kimi-code', 'skills', 'conf-skill'), { recursive: true });
        await writeFile(
          join(workDir, '.kimi-code', 'skills', 'conf-skill', 'SKILL.md'),
          '---\nname: conf-skill\ndescription: conformance fixture skill\n---\n\n# Conf body\n',
        );
        const created = await target.klient.global.sessions.create({ workDir });
        try {
          const agent = target.klient.session(created.id).agent('main');

          await expect(
            agent.promptWithSkills({
              input: [{ type: 'text', text: 'Run the fixture skill.' }],
              skills: [{ name: 'missing-skill' }],
            }),
          ).rejects.toThrow(/not found/i);

          const launched = await agent.promptWithSkills({
            input: [{ type: 'text', text: 'Run the fixture skill.' }],
            skills: [{ name: 'conf-skill', args: 'src/app.ts' }],
            steerIfActive: true,
          });
          expect(launched).toMatchObject({ turn_id: 0, state: 'running' });
          expect(launched.prompt_id.length).toBeGreaterThan(0);
          expect(launched.created_at.length).toBeGreaterThan(0);

          const { history } = await agent.getContext();
          const bundled = history.find(
            (message) => message.role === 'user' && message.origin?.kind === 'user',
          );
          expect(bundled?.origin).toMatchObject({
            kind: 'user',
            skillActivations: [{ skillName: 'conf-skill', skillArgs: 'src/app.ts' }],
          });
          const texts = bundled?.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text);
          expect(texts?.[0]).toContain('# Conf body');
          expect(texts?.[0]).toContain('ARGUMENTS: src/app.ts');
          expect(texts?.[1]).toBe('Run the fixture skill.');
        } finally {
          await target.klient.session(created.id).close();
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('providers.set/get/delete works and emits kosong.providers.changed', async () => {
      const events: Array<{
        added: readonly string[];
        removed: readonly string[];
        changed: readonly string[];
      }> = [];
      const errors: Error[] = [];
      target.klient.events.onError((error) => {
        errors.push(error);
      });
      const sub = target.klient.events.on('kosong.providers.changed', (event) => {
        events.push(event);
      });
      // Give the subscription a wire round-trip (memory is synchronous; ipc
      // and http's lazy WS need a frame exchange).
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });

      const name = '__klient_conformance__';
      try {
        await target.klient.global.kosong.addProvider(name, {
          type: 'openai',
          auth: { method: 'api-key', apiKey: 'conf-key' },
        });
        const got = await target.klient.global.kosong.getProvider(name);
        expect(got.has_api_key).toBe(true);

        await waitFor(
          () => events.some((event) => [...event.added, ...event.changed].includes(name)),
          5_000,
        );
      } finally {
        await target.klient.global.kosong.removeProvider(name);
        sub.dispose();
      }
      expect(errors).toEqual([]);
    });

    it('config reads respond', async () => {
      const all = await target.klient.global.config.getAll();
      expect(typeof all).toBe('object');
      expect(Array.isArray(await target.klient.global.config.diagnostics())).toBe(true);
    });

    it('settings reads a sanitized snapshot and round-trips provider edits', async () => {
      const { settings, config } = target.klient.global;
      const before = await config.inspect<Record<string, unknown>>('providers');
      try {
        const snapshot = await settings.read();
        expect(snapshot.scope).toBe('runtime');
        expect(snapshot.revision).toMatch(/^[0-9a-f]{64}$/);
        expect(snapshot.homeDir.length).toBeGreaterThan(0);

        const saved = await settings.saveProvider({
          revision: snapshot.revision,
          id: 'conformance-provider',
          patch: {
            type: 'openai',
            baseUrl: 'https://api.example.test/v1',
            defaultModel: 'demo-m1',
          },
          credential: { action: 'replace', value: 'sk-conformance-secret' },
        });
        expect(saved.effective).toBe('next-request');
        let provider = saved.settings.providers.find((p) => p.id === 'conformance-provider');
        expect(provider?.credential).toMatchObject({ kind: 'api-key', configured: true });
        expect(provider?.baseUrl).toBe('https://api.example.test/v1');
        expect(JSON.stringify(saved.settings)).not.toContain('sk-conformance-secret');

        await expect(
          settings.saveProvider({
            revision: snapshot.revision,
            id: 'conformance-provider',
            patch: {},
            credential: { action: 'keep' },
          }),
        ).rejects.toMatchObject({ code: 40930 });

        const kept = await settings.saveProvider({
          revision: saved.settings.revision,
          id: 'conformance-provider',
          patch: { defaultModel: 'demo-m2' },
          credential: { action: 'keep' },
        });
        provider = kept.settings.providers.find((p) => p.id === 'conformance-provider');
        expect(provider?.credential.kind).toBe('api-key');
        expect(provider?.defaultModel).toBe('demo-m2');
        let stored = await config.inspect<
          Record<string, { apiKey?: string; apiKeyEnv?: string }>
        >('providers');
        expect(stored.userValue?.['conformance-provider']?.apiKey).toBe(
          'sk-conformance-secret',
        );

        const envBound = await settings.saveProvider({
          revision: kept.settings.revision,
          id: 'conformance-provider',
          patch: {},
          credential: { action: 'environment', name: 'KLIENT_CONFORMANCE_KEY' },
        });
        provider = envBound.settings.providers.find((p) => p.id === 'conformance-provider');
        expect(provider?.credential).toMatchObject({
          kind: 'environment',
          environment: 'KLIENT_CONFORMANCE_KEY',
          resolved: false,
        });
        stored = await config.inspect<
          Record<string, { apiKey?: string; apiKeyEnv?: string }>
        >('providers');
        expect(stored.userValue?.['conformance-provider']?.apiKeyEnv).toBe(
          'KLIENT_CONFORMANCE_KEY',
        );
        expect(stored.userValue?.['conformance-provider']?.apiKey).toBeUndefined();

        const cleared = await settings.saveProvider({
          revision: envBound.settings.revision,
          id: 'conformance-provider',
          patch: {},
          credential: { action: 'clear' },
        });
        provider = cleared.settings.providers.find((p) => p.id === 'conformance-provider');
        expect(provider?.credential).toMatchObject({ kind: 'none', configured: false });
        stored = await config.inspect<
          Record<string, { apiKey?: string; apiKeyEnv?: string }>
        >('providers');
        expect(stored.userValue?.['conformance-provider']?.apiKeyEnv).toBeUndefined();

        const events: Array<{ revision: string }> = [];
        const sub = target.klient.events.on('settings.changed', (event) => {
          events.push(event);
        });
        try {
          await settings.removeProvider({
            revision: cleared.settings.revision,
            id: 'conformance-provider',
          });
          await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
          expect(events.at(-1)?.revision).toMatch(/^[0-9a-f]{64}$/);
        } finally {
          sub.dispose();
        }
        const after = await settings.read();
        expect(after.providers.find((p) => p.id === 'conformance-provider')).toBeUndefined();
      } finally {
        await config.replaceSections({
          sections: { providers: before.userValue ?? {} },
        });
      }
    });

    it('terminals open/write/resize/close route through the session facade', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'klient-terminal-'));
      await mkdir(join(workDir, '.git'));
      const created = await target.klient.global.sessions.create({
        workDir,
        title: 'terminal conformance',
      });
      try {
        const session = target.klient.session(created.id);
        const frames: TerminalStreamFrame[] = [];
        for await (const frame of session.terminals.open({ cols: 100, rows: 30 })) {
          frames.push(frame);
        }
        expect(frames).toHaveLength(2);
        expect(frames[0]).toMatchObject({
          type: 'terminal_ready',
          terminal: { id: 'conf-term' },
        });
        expect(frames[1]).toMatchObject({
          type: 'terminal_output',
          payload: { data: 'conf-ok' },
        });

        const service = ConformanceTerminalService.instances.at(-1);
        expect(service?.opened).toEqual([
          { cols: 100, rows: 30, runtime_id: 'local' },
        ]);

        await session.terminals.write({ id: 'conf-term', data: 'echo hi\n' });
        await session.terminals.resize({ id: 'conf-term', cols: 120, rows: 40 });
        await expect(session.terminals.close('conf-term')).resolves.toEqual({
          closed: true,
        });
        expect(service?.writes).toEqual([{ id: 'conf-term', data: 'echo hi\n' }]);
        expect(service?.resizes).toEqual([{ id: 'conf-term', cols: 120, rows: 40 }]);
        expect(service?.closedIds).toEqual(['conf-term']);

        await expect(
          session.terminals.resize({ id: 'conf-term', cols: 0, rows: 40 }),
        ).rejects.toThrow(KlientValidationError);
        const sessionScope = { sessionId: created.id };
        await expect(
          target.rawCall('sessionTerminalService', 'resize', ['conf-term', 0, 40], sessionScope),
        ).rejects.toMatchObject({ code: 40001 });
        await expect(
          target.rawCall(
            'sessionTerminalService',
            'write',
            ['conf-term', 'x'.repeat(70 * 1024)],
            sessionScope,
          ),
        ).rejects.toMatchObject({ code: 40001 });
      } finally {
        await target.klient.session(created.id).close();
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('config replaceSections writes several domains and clears undefined ones', async () => {
      const config = target.klient.global.config;
      const beforeProviders = await config.inspect<Record<string, unknown>>('providers');
      const beforeModels = await config.inspect<Record<string, unknown>>('models');
      try {
        await config.replaceSections({
          sections: {
            providers: {
              ...beforeProviders.userValue,
              'conf-provider': { type: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' },
            },
            models: {
              ...beforeModels.userValue,
              'conf-provider/m1': { provider: 'conf-provider', model: 'm1', maxContextSize: 100 },
            },
            defaultModel: 'conf-provider/m1',
          },
        });
        expect((await config.inspect<string>('defaultModel')).userValue).toBe('conf-provider/m1');

        // A domain mapped to `undefined` is cleared; domains absent from the
        // sections record are left untouched.
        await config.replaceSections({ sections: { defaultModel: undefined } });
        expect((await config.inspect<string>('defaultModel')).userValue).toBeUndefined();
        const providers = await config.inspect<Record<string, unknown>>('providers');
        expect(providers.userValue?.['conf-provider']).toBeDefined();
      } finally {
        await config.replaceSections({
          sections: { providers: beforeProviders.userValue, models: beforeModels.userValue },
        });
      }
    });

    it('keeps a credential binding edited while the registry response is in flight', async () => {
      const { config, kosong } = target.klient.global;
      const domains = ['providers', 'models', 'defaultModel', 'defaultProvider', 'thinking'];
      const before = Object.fromEntries(
        await Promise.all(domains.map(async (domain) => [
          domain, (await config.inspect(domain)).userValue,
        ])),
      );
      const url = 'https://registry.example.test/api.json';
      const source = { kind: 'apiJson', url, apiKey: '' };
      const provider = { type: 'openai', baseUrl: 'https://owned.example.test/v1', source };
      try {
        await config.replaceSections({
          sections: {
            providers: { owned: { ...provider, apiKeyEnv: 'FIRST_EXAMPLE_KEY' } },
            models: {},
            defaultModel: undefined,
            defaultProvider: undefined,
            thinking: undefined,
          },
        });
        setModelsDevUpstreamForTest({
          fetchImpl: async () => {
            await config.set({
              domain: 'providers',
              patch: { owned: { apiKeyEnv: 'SECOND_EXAMPLE_KEY' } },
            });
            return Response.json({
              owned: {
                id: 'owned',
                name: 'Owned',
                type: 'openai',
                api: provider.baseUrl,
                models: { m1: { id: 'm1' } },
              },
            });
          },
        });
        await kosong.importCustomRegistry({ url, setDefaultWhenUnset: false });
        await config.reload();
        const providers = await config.inspect<Record<string, { apiKeyEnv?: string }>>('providers');
        expect(providers.userValue?.['owned']?.apiKeyEnv).toBe('SECOND_EXAMPLE_KEY');
      } finally {
        resetModelsDevUpstreamForTest();
        await config.replaceSections({ sections: before });
      }
    });

    it('hostFs.home() returns the host home and recent roots', async () => {
      const home = await target.klient.global.hostFs.home();
      expect(home.home.length).toBeGreaterThan(0);
      expect(Array.isArray(home.recent_roots)).toBe(true);

      const browse = await target.klient.global.hostFs.browse(home.home);
      expect(browse.path).toBe(home.home);
      expect(Array.isArray(browse.entries)).toBe(true);
    });

    it('files save/get/delete round-trips bytes through the file store', async () => {
      const files = target.klient.global.files;
      const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
      const meta = await files.save({
        data: bytes,
        filename: 'conformance.bin',
        mimeType: 'application/octet-stream',
        expiresInSec: 3600,
      });
      expect(meta.id.startsWith('f_')).toBe(true);
      expect(meta.name).toBe('conformance.bin');
      expect(meta.media_type).toBe('application/octet-stream');
      expect(meta.size).toBe(bytes.length);
      expect(typeof meta.expires_at).toBe('string');

      const downloaded = await files.get(meta.id);
      expect(downloaded.meta).toEqual(meta);
      expect([...downloaded.data]).toEqual([...bytes]);

      await files.delete(meta.id);
      // Both transports surface a deleted/expired upload as the same public
      // RPCError code, never the engine's raw error type.
      await expect(files.get(meta.id)).rejects.toMatchObject({ name: 'RPCError', code: 40404 });
    });

    it('kosong lists models/providers and anonymous provider round-trips', async () => {
      const kosong = target.klient.global.kosong;
      expect(Array.isArray(await kosong.listModels())).toBe(true);
      expect(Array.isArray(await kosong.listProviders())).toBe(true);

      const events: Array<{
        added: readonly string[];
        removed: readonly string[];
        changed: readonly string[];
      }> = [];
      const sub = target.klient.events.on('kosong.models.changed', (event) => {
        events.push(event);
      });
      // See kosong.providers.changed above — give the subscription a wire round-trip.
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });

      const id = '__klient_conformance__';
      try {
        await kosong.addProvider({
          id,
          model: 'conf-model',
          protocol: 'openai',
          baseUrl: 'http://127.0.0.1:1',
          auth: { method: 'api-key', apiKey: 'conf-key' },
        });

        await waitFor(
          () => events.some((event) => [...event.added, ...event.changed].includes(id)),
          5_000,
        );
      } finally {
        await kosong.removeProvider(id);
        sub.dispose();
      }
    });

    it('catalog thinking and profile binding round-trip through every transport', async () => {
      const config = target.klient.global.config;
      const beforeProviders = await config.inspect<Record<string, unknown>>('providers');
      const beforeModels = await config.inspect<Record<string, unknown>>('models');
      const beforeDefaultModel = await config.inspect<string>('defaultModel');
      const providerId = 'conf-thinking-provider';
      const modelId = 'conf-thinking-model';
      await config.replaceSections({
        sections: {
          providers: {
            ...beforeProviders.userValue,
            [providerId]: {
              type: 'openai',
              baseUrl: 'http://127.0.0.1:1',
              apiKey: 'conf-key',
            },
          },
          models: {
            ...beforeModels.userValue,
            [modelId]: {
              provider: providerId,
              model: 'upstream-thinking-model',
              maxContextSize: 16_384,
              thinking: {
                availability: 'dynamic',
                canDisable: true,
                controls: ['toggle', 'effort'],
                efforts: ['low', 'high'],
                providerEfforts: { openai: ['high'] },
                defaultEffort: 'high',
              },
            },
          },
          defaultModel: modelId,
        },
      });

      try {
        const model = (await target.klient.global.kosong.listModels()).find(
          (item) => item.model === modelId,
        );
        expect(model).toMatchObject({
          provider: providerId,
          model: modelId,
          max_context_size: 16_384,
          thinking: {
            availability: 'dynamic',
            can_disable: true,
            controls: ['toggle', 'effort'],
            efforts: ['low', 'high'],
            provider_efforts: { openai: ['high'] },
            default_effort: 'high',
          },
          support_efforts: ['high'],
          default_effort: 'high',
        });

        const created = await target.klient.global.sessions.create({
          workDir: process.cwd(),
          title: 'conformance profile binding',
        });
        try {
          const agent = target.klient.session(created.id).agent('main');
          await agent.bindProfile({
            profile: 'agent',
            model: modelId,
            thinking: 'high',
            strictThinking: true,
          });
          expect(await agent.getModel()).toBe(modelId);
          expect(await agent.getThinking()).toBe('high');
          await expect(agent.setModel(modelId, 'off')).resolves.toMatchObject({ model: modelId, thinking: 'off' });
          expect(await agent.getThinking()).toBe('off');
          await expect(agent.setModel(modelId, 'high')).resolves.toMatchObject({ model: modelId, thinking: 'high' });
          expect(await agent.getThinking()).toBe('high');
        } finally {
          await target.klient.session(created.id).close();
        }
      } finally {
        await config.replaceSections({
          sections: {
            providers: beforeProviders.userValue,
            models: beforeModels.userValue,
            defaultModel: beforeDefaultModel.userValue,
          },
        });
      }
    });

    it('lists builtin providers without persisting configuration or exposing credentials', async () => {
      const config = target.klient.global.config;
      const beforeProviders = await config.inspect('providers');
      const beforeModels = await config.inspect('models');
      const providers = await target.klient.global.kosong.listBuiltinProviders();
      expect(providers.map((provider) => provider.id)).toEqual(expect.arrayContaining([
        'openai', 'anthropic', 'google', 'zai', 'kimi-coding', 'deepseek', 'minimax', 'xiaomi', 'qwen-token-plan-cn',
      ]));
      for (const provider of providers) {
        expect(provider.has_api_key).toBe(false);
        expect(provider.status).toBe('unconfigured');
        if (provider.id !== 'vsplab') {
          expect(provider.models?.length).toBeGreaterThan(0);
        }
        expect(provider).not.toHaveProperty('apiKey');
        expect(provider).not.toHaveProperty('oauth');
      }
      expect(await config.inspect('providers')).toEqual(beforeProviders);
      expect(await config.inspect('models')).toEqual(beforeModels);
    });

    it('lists configuration aliases separately from the actual API model ID', async () => {
      const config = target.klient.global.config;
      const beforeProviders = await config.inspect<Record<string, unknown>>('providers');
      const beforeModels = await config.inspect<Record<string, unknown>>('models');
      try {
        await config.replaceSections({ sections: {
          providers: { ...beforeProviders.userValue, example: { type: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'YOUR_API_KEY' } },
          models: { ...beforeModels.userValue, 'example/review': { provider: 'example', model: 'actual-model', aliases: ['alternate-model'], maxContextSize: 8192, canonical: { id: 'anthropic/claude-opus-5.5' } } },
        } });
        const model = (await target.klient.global.kosong.listModels()).find(item => item.model === 'example/review');
        expect(model).toMatchObject({ model: 'example/review', wire_model: 'actual-model', aliases: ['alternate-model'], base_url: 'https://example.test/v1', canonical: { id: 'anthropic/claude-opus-5.5', company: 'Anthropic', displayName: 'Claude Opus 5.5' } });
      } finally {
        await config.replaceSections({ sections: { providers: beforeProviders.userValue ?? {}, models: beforeModels.userValue ?? {} } });
      }
    });

    it('configures builtin providers persistently while retaining user model overrides and the default', async () => {
      const config = target.klient.global.config;
      const kosong = target.klient.global.kosong;
      const beforeProviders = await config.inspect<Record<string, unknown>>('providers');
      const beforeModels = await config.inspect<Record<string, unknown>>('models');
      const beforeDefaultModel = await config.inspect<string>('defaultModel');
      const alias = 'openai/gpt-5';
      const override = {
        provider: 'openai', model: 'gpt-5', maxContextSize: 32000, capabilities: [],
        thinking: { availability: 'always', canDisable: false, controls: ['effort'], efforts: ['high'], defaultEffort: 'high' },
      };
      try {
        await config.replaceSections({
          sections: {
            providers: { ...beforeProviders.userValue, openai: { type: 'openai', baseUrl: 'https://gateway.example.test/v1' } },
            models: { ...beforeModels.userValue, [alias]: override },
            defaultModel: alias,
          },
        });
        await kosong.configureBuiltinProvider('openai', 'EXAMPLE_API_KEY');
        await config.reload();
        expect(await config.get('defaultModel')).toBe(alias);
        expect((await config.get<Record<string, unknown>>('models'))[alias]).toMatchObject(override);
        expect((await config.get<Record<string, unknown>>('providers'))['openai']).toMatchObject({
          type: 'openai', apiKey: 'EXAMPLE_API_KEY', baseUrl: 'https://gateway.example.test/v1',
        });
        const models = await kosong.listModels();
        expect(models.find((model) => model.model === alias)).toMatchObject({
          max_context_size: 32000, support_efforts: ['high'], default_effort: 'high',
        });
        expect(models.find((model) => model.model === alias)?.capabilities).not.toContain('image_in');
        expect(models.some((model) => model.model === 'openai/gpt-4o')).toBe(true);
        expect(JSON.stringify(await kosong.listProviders())).not.toContain('EXAMPLE_API_KEY');
        const beforeInvalid = await config.get('providers');
        await expect(kosong.configureBuiltinProvider('unknown-example-provider', 'EXAMPLE_API_KEY')).rejects.toThrow();
        await expect(kosong.configureBuiltinProvider('openai', '')).rejects.toThrow();
        expect(await config.get('providers')).toEqual(beforeInvalid);
      } finally {
        await config.replaceSections({
          sections: {
            providers: beforeProviders.userValue,
            models: beforeModels.userValue,
            defaultModel: beforeDefaultModel.userValue,
          },
        });
      }
    });

    it('flags / plugins / auth read models respond', async () => {
      expect(Array.isArray(await target.klient.global.flags.list())).toBe(true);
      expect(Array.isArray(await target.klient.global.flags.enabledIds())).toBe(true);
      expect(typeof await target.klient.global.flags.snapshot()).toBe('object');
      expect(Array.isArray(await target.klient.global.plugins.list())).toBe(true);
      const status = await target.klient.global.auth.status();
      expect(typeof status.loggedIn).toBe('boolean');
      expect((await target.klient.global.auth.listLoginProviders()).map((provider) => provider.id))
        .toEqual(expect.arrayContaining(['managed:kimi-code', 'anthropic', 'openai-codex', 'github-copilot', 'devin']));
      const localCredentials = await target.klient.global.auth.listLocalCredentials();
      expect(Array.isArray(localCredentials)).toBe(true);
      for (const entry of localCredentials) {
        expect(typeof entry.id).toBe('string');
        expect(Object.keys(entry).every(key => ['id', 'provider', 'name', 'account', 'expiresAt'].includes(key))).toBe(true);
      }
      await expect(target.klient.global.auth.useLocalCredential('nonexistent-example-cli')).rejects.toThrow();
      await expect(target.klient.global.auth.submitLogin('anthropic', 'stale-flow', 'stale-prompt', 'example-code'))
        .rejects.toThrow();
    });

    it('rejects raw OAuth credential access outside the public auth contract', async () => {
      for (const method of ['getCachedAccessToken', 'resolveRequestAuth', 'resolveTokenProvider', 'toolkit', 'pi']) {
        await expect(target.rawCall('oauthService', method, ['anthropic']))
          .rejects.toMatchObject({ code: 40001 });
      }
    });

    it('global mcp round-trips user-level server CRUD', async () => {
      const mcp = target.klient.global.mcp;
      const cwd = await mkdtemp(join(tmpdir(), 'klient-conf-mcp-crud-'));
      try {
        expect(await mcp.list({ cwd })).toEqual([]);

        const added = await mcp.add({
          cwd,
          server: {
            name: 'conf-mcp',
            transport: 'stdio',
            command: 'conf-command',
            env: { TOKEN: 'secret' },
          },
        });
        const entry = added.find((server) => server.name === 'conf-mcp');
        // Mutable (user-level) entries carry the full config for edit prefill.
        expect(entry).toMatchObject({
          name: 'conf-mcp',
          source: 'global',
          mutable: true,
          config: { transport: 'stdio', command: 'conf-command', env: { TOKEN: 'secret' } },
        });

        await mcp.update({
          cwd,
          server: { name: 'conf-mcp', transport: 'stdio', command: 'conf-command-2' },
        });
        expect((await mcp.get({ name: 'conf-mcp', cwd })).config).toMatchObject({
          command: 'conf-command-2',
        });

        await mcp.remove({ name: 'conf-mcp', cwd });
        expect(await mcp.list({ cwd })).toEqual([]);
        await expect(mcp.get({ name: 'conf-mcp', cwd })).rejects.toMatchObject({
          name: 'RPCError',
          code: 40408,
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('global mcp probes an inline server config without persisting it', async () => {
      const mcp = target.klient.global.mcp;
      // Inline probe against a scratch cwd: the binary runs but never
      // speaks MCP, so the connection test reports a clean failure.
      const probeCwd = await mkdtemp(join(tmpdir(), 'klient-conf-mcp-probe-'));
      try {
        const probe = await mcp.test({
          server: {
            name: 'conf-probe',
            transport: 'stdio',
            command: process.execPath,
            args: ['--version'],
            startupTimeoutMs: 10_000,
          },
          cwd: probeCwd,
        });
        expect(probe.success).toBe(false);
        expect(typeof probe.output).toBe('string');
      } finally {
        await rm(probeCwd, { recursive: true, force: true });
      }
      expect(await mcp.list()).toEqual([]);
    });

    it('global mcp resolves locators and classifies auth offline', async () => {
      const mcp = target.klient.global.mcp;
      await mcp.add({
        server: { name: 'conf-mcp', transport: 'stdio', command: 'conf-command' },
      });
      try {
        // The locator surface: resolve a legacy name, inspect nothing/all.
        expect(await mcp.resolveByName({ name: 'conf-mcp' })).toEqual({
          source: 'global',
          name: 'conf-mcp',
        });
        expect(await mcp.inspect({ targets: [] })).toEqual([]);
        // An omitted `targets` ahead of a present options arg must mean "the
        // whole catalog" on every transport (ipc encodes it as `null`).
        expect((await mcp.inspect({})).map((i) => i.runtimeName)).toContain('conf-mcp');
        await expect(
          mcp.inspect({ targets: [{ source: 'global', name: 'conf-missing' }] }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40408 });

        // Offline auth classification of a stdio server needs no probe, and
        // an OAuth flow against a stdio target is request.invalid → 40001.
        expect(await mcp.authStatuses()).toEqual([
          { name: 'conf-mcp', authStatus: 'not-applicable' },
        ]);
        await expect(
          mcp.beginAuth({ locator: { source: 'global', name: 'conf-mcp' } }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40001 });
      } finally {
        await mcp.remove({ name: 'conf-mcp' });
      }
    });

    it('global mcp completeAuth rejects an unknown flowId with 40001', async () => {
      const mcp = target.klient.global.mcp;
      await expect(mcp.completeAuth({ flowId: 'conf-unknown-flow' })).rejects.toMatchObject({
        name: 'RPCError',
        code: 40001,
      });
    });

    it('global mcp OAuth failures map to the 40929 wire code on every transport', async () => {
      const mcp = target.klient.global.mcp;
      await mcp.add({
        server: {
          name: 'conf-oauth-failure',
          transport: 'http',
          url: 'http://127.0.0.1:1/mcp',
          auth: 'oauth',
        },
      });
      try {
        await expect(
          mcp.beginAuth({ locator: { source: 'global', name: 'conf-oauth-failure' } }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40929 });
      } finally {
        await mcp.remove({ name: 'conf-oauth-failure' });
      }
    });

    it('global mcp cancelAuth ignores an unknown flowId', async () => {
      const mcp = target.klient.global.mcp;
      await expect(mcp.cancelAuth({ flowId: 'conf-unknown-flow' })).resolves.toBeUndefined();
    });

    it('global mcp resetAuth clears a remote oauth server through the transport', async () => {
      const mcp = target.klient.global.mcp;
      await mcp.add({
        server: {
          name: 'conf-oauth',
          transport: 'http',
          url: 'http://127.0.0.1:1/mcp',
          auth: 'oauth',
        },
      });
      try {
        // Invalidate is offline: no stored grant and no network needed.
        await expect(
          mcp.resetAuth({ locator: { source: 'global', name: 'conf-oauth' } }),
        ).resolves.toBeUndefined();
      } finally {
        await mcp.remove({ name: 'conf-oauth' });
      }
    });

    it('global mcp resetAuth rejects a stdio locator with 40001', async () => {
      const mcp = target.klient.global.mcp;
      await mcp.add({
        server: { name: 'conf-stdio', transport: 'stdio', command: 'conf-command' },
      });
      try {
        await expect(
          mcp.resetAuth({ locator: { source: 'global', name: 'conf-stdio' } }),
        ).rejects.toMatchObject({ name: 'RPCError', code: 40001 });
      } finally {
        await mcp.remove({ name: 'conf-stdio' });
      }
    });

    it('agent goal view returns no current Goal through every transport', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance goal view',
      });
      try {
        await expect(target.klient.session(created.id).agent('main').getGoal()).resolves.toEqual({
          goal: null,
        });
      } finally {
        await target.klient.session(created.id).close();
      }
    });

    it('detachTask releases a foreground shell command while its process keeps running', async () => {
      const workDir = process.cwd();
      const created = await target.klient.global.sessions.create({
        workDir,
        title: 'conformance foreground detach',
      });
      const agent = target.klient.session(created.id).agent('main');
      const commandId = 'conformance-detach';
      let taskId: string | undefined;
      let foreground: ReturnType<typeof agent.runShellCommand> | undefined;
      try {
        foreground = agent.runShellCommand({
          command: `exec '${process.execPath.replaceAll("'", "'\\''")}' -e 'setInterval(() => {}, 60000)'`,
          commandId,
        });
        void foreground.catch(() => {});
        await vi.waitFor(async () => {
          const tasks = await agent.getTasks({ activeOnly: true });
          const task = tasks.find((item) => item.kind === 'process' && item.detached === false);
          expect(task).toMatchObject({ status: 'running', detached: false });
          taskId = task?.taskId;
        });
        if (taskId === undefined) throw new Error('foreground task was not registered');

        await expect(agent.detachTask({ taskId })).resolves.toBeUndefined();

        await expect(foreground).resolves.toMatchObject({ backgrounded: true, isError: false });
        expect(await agent.getTask(taskId)).toMatchObject({ status: 'running', detached: true });
      } finally {
        try {
          await agent.cancelShellCommand({ commandId });
          if (taskId !== undefined) await agent.stopTask({ taskId });
          await foreground?.catch(() => {});
        } finally {
          await target.klient.session(created.id).close();
        }
      }
    });

    it('agent goal lifecycle RPCs reject without a current Goal through every transport', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance goal lifecycle',
      });
      try {
        const agent = target.klient.session(created.id).agent('main');
        await expect(agent.pauseGoal()).rejects.toThrow(/No current goal/);
        await expect(agent.resumeGoal()).rejects.toThrow(/No current goal/);
        await expect(agent.cancelGoal()).rejects.toThrow(/No current goal/);
      } finally {
        await target.klient.session(created.id).close();
      }
    });

    it('agent goal events retain stream metadata through every transport', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance goal events',
      });
      const disposables: Array<{ dispose(): void }> = [];
      try {
        const agent = target.klient.session(created.id).agent('main');
        const seen: Array<{
          snapshot: { status: string } | null;
          viewRevision?: unknown;
          viewSegment?: unknown;
        }> = [];
        const errors: Error[] = [];
        disposables.push(
          agent.events.onError((error) => errors.push(error)),
          agent.events.on('goal.updated', (event) =>
            seen.push(
              event as {
                snapshot: { status: string } | null;
                viewRevision?: unknown;
                viewSegment?: unknown;
              },
            ),
          ),
        );
        await agent.getGoal();

        const session =
          target.app.accessor.get(ISessionManager).get(created.id) ??
          getLiveSessionById(target.app.accessor, created.id);
        if (session === undefined) throw new Error(`session not materialized: ${created.id}`);
        const context = await ensureMainAgent(session);
        const handle = session.accessor
          .get(IAgentLifecycleService)
          .handleOf(context.agentId);
        if (handle === undefined) throw new Error('main agent was not found');
        const goals = handle.accessor.get(IAgentGoalService);

        await goals.createGoal({ objective: 'Complete the example task' });
        await agent.pauseGoal();
        await agent.cancelGoal();

        await waitFor(() => seen.length >= 3, 10_000);
        expect(seen.map((event) => event.snapshot?.status ?? null)).toEqual([
          'active',
          'paused',
          null,
        ]);
        expect(errors).toEqual([]);
        for (const event of seen) {
          // The dispatcher stamps every observed event with viewRevision;
          // viewSegment only exists while a turn segment is live.
          expect(Number.isSafeInteger(event.viewRevision)).toBe(true);
          expect(
            event.viewSegment === undefined || Number.isSafeInteger(event.viewSegment),
          ).toBe(true);
        }
      } finally {
        for (const disposable of disposables) disposable.dispose();
        await target.klient.session(created.id).close();
      }
    });

    it('agent runtime binding is available through every transport', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance runtime',
      });
      try {
        const agent = target.klient.session(created.id).agent('main');
        const binding = await agent.getRuntime();
        expect(binding.runtimeId).toBe('local');
        expect(binding.workspaceId.length).toBeGreaterThan(0);
        await expect(agent.switchRuntime('missing-runtime')).rejects.toThrow(/missing-runtime/);
        expect(await agent.getRuntime()).toEqual(binding);
      } finally {
        await target.klient.session(created.id).close();
      }
    });

    it('agent commands list and run a contributed command', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance commands',
      });
      const calls: string[] = [];

      // A dynamic App-scope unit contributing one command into the
      // `CommandContribution` collection — the same path a Feature takes.
      class ConformanceCommands extends Service {
        static override readonly name = 'klient-conformance-commands';
        constructor() {
          super();
          this.provide(CommandContribution, {
            name: 'conformance-echo',
            description: 'records its args',
            run: (ctx) => {
              calls.push(ctx.args);
            },
          });
        }
      }

      const featureManager = target.app.accessor.get(IFeatureManager);
      const handle = featureManager.provideUnit(ConformanceCommands);
      try {
        const agent = target.klient.session(created.id).agent('main');

        // Dynamic assembly goes through the cascade — poll until visible.
        let infos = await agent.listCommands();
        const deadline = Date.now() + 5_000;
        while (!infos.some((command) => command.name === 'conformance-echo')) {
          if (Date.now() > deadline) break;
          await new Promise((resolve) => {
            setTimeout(resolve, 25);
          });
          infos = await agent.listCommands();
        }
        expect(infos.map((command) => command.name)).toContain('conformance-echo');
        const echo = infos.find((command) => command.name === 'conformance-echo');
        expect(echo).toMatchObject({ name: 'conformance-echo', description: 'records its args' });
        expect(typeof echo?.source).toBe('string');

        await agent.runCommand({ name: 'conformance-echo', args: 'hello commands' });
        expect(calls).toEqual(['hello commands']);

        // Unknown names fail with a coded engine error.
        await expect(agent.runCommand({ name: 'conformance-missing' })).rejects.toThrow(
          /Unknown command/,
        );
      } finally {
        await handle.dispose();
        await target.klient.session(created.id).close();
      }
    });

    it('treats a client-chosen promptId as a pure correlation id', async () => {
      const created = await target.klient.global.sessions.create({
        workDir: process.cwd(),
        title: 'conformance prompt correlation',
      });
      try {
        const agent = target.klient.session(created.id).agent('main');
        const first = await agent.prompt({
          input: [{ type: 'text', text: 'first' }],
          promptId: 'submission-1',
        });
        expect(first).toEqual({ turn_id: 0 });
        const second = await agent.prompt({
          input: [{ type: 'text', text: 'duplicate' }],
          promptId: 'submission-1',
        });
        expect(second === undefined || typeof second.turn_id === 'number').toBe(true);
      } finally {
        await target.klient.session(created.id).close();
      }
    });
  });
}
