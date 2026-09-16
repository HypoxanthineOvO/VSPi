import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { startServer } from '@moonshot-ai/kap-server';
import {
  AgentGoal, GoalUpdated, IAgentLifecycleService, IEventBus, IFlagService,
  ISessionManager, type IDisposable, type ISessionScopeHandle,
} from '@moonshot-ai/agent-core-v2';
import { GOAL_RESTART_RECOVERY_FLAG } from '@moonshot-ai/agent-core-v2/features/goal/flag';

type Core = Awaited<ReturnType<typeof startServer>>['core'];

export class RuntimeGoalRecovery {
  private readonly candidates = new Map<string, string>();
  private readonly subscriptions: IDisposable[] = [];
  private readonly sessions = new Map<string, IDisposable[]>();
  private writing: Promise<void> = Promise.resolve();
  private stopping = false;

  constructor(private readonly core: Core, private readonly directory: string) {}

  private get enabled(): boolean { return this.core.accessor.get(IFlagService).enabled(GOAL_RESTART_RECOVERY_FLAG); }

  async start(): Promise<void> {
    if (!this.enabled) return;
    try {
      const value: unknown = JSON.parse(await readFile(join(this.directory, 'goal-recovery.json'), 'utf8'));
      if (!Array.isArray(value)) throw new Error('Invalid goal recovery index');
      for (const entry of value) {
        if (entry && typeof entry === 'object' && typeof entry.sessionId === 'string' && typeof entry.goalId === 'string')
          this.candidates.set(entry.sessionId, entry.goalId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.report('index-read-failed', error);
    }
    const restore = [...this.candidates.keys()];
    const manager = this.core.accessor.get(ISessionManager);
    if (manager.onDidCreateSession) this.subscriptions.push(manager.onDidCreateSession(event => {
      this.attach(event.handle);
      if (event.source === 'resume' && !this.stopping && this.enabled) {
        const agents = event.handle.accessor.get(IAgentLifecycleService);
        const main = agents.get('main');
        if (main) agents.resolve(main, AgentGoal).resumeAfterRuntimeRestart();
      }
    }));
    if (manager.onWillCloseSession) this.subscriptions.push(manager.onWillCloseSession(event => {
      this.remember(event.sessionId, undefined);
      this.detach(event.sessionId);
      event.waitUntil(this.writing);
    }));
    for (const session of manager.list()) this.attach(session);
    for (const sessionId of restore) {
      if (this.stopping || !this.enabled) break;
      try {
        const summary = await manager.status(sessionId);
        if (summary === undefined || summary.archived) { this.remember(sessionId, undefined); continue; }
        await manager.resume(sessionId);
      } catch (error) { this.report('session-resume-failed', error, sessionId); }
    }
    await this.writing;
  }

  private attach(session: ISessionScopeHandle): void {
    if (this.sessions.has(session.id)) return;
    const subscriptions: IDisposable[] = [];
    this.sessions.set(session.id, subscriptions);
    const agents = session.accessor.get(IAgentLifecycleService);
    let mainSubscription: IDisposable | undefined;
    subscriptions.push({ dispose: () => { mainSubscription?.dispose(); } });
    const watch = (agentId: string) => {
      if (agentId !== 'main') return;
      const handle = agents.handleOf(agentId);
      if (!handle) return;
      mainSubscription?.dispose();
      mainSubscription = handle.accessor.get(IEventBus).subscribe(GoalUpdated, event => {
        if (!this.enabled) return;
        this.remember(session.id, event.snapshot?.status === 'active' ? event.snapshot.goalId : undefined);
      });
    };
    subscriptions.push(agents.onDidCreateScope(event => { watch(event.context.agentId); }));
    subscriptions.push(agents.onDidClose(agent => {
      if (agent.agentId !== 'main' || agents.get('main') !== undefined) return;
      mainSubscription?.dispose();
      mainSubscription = undefined;
      if (!this.stopping) this.remember(session.id, undefined);
    }));
    const main = agents.get('main');
    if (main) {
      watch('main');
      const goal = agents.resolve(main, AgentGoal).getGoal().goal;
      this.remember(session.id, goal?.status === 'active' ? goal.goalId : undefined);
    }
  }

  private remember(sessionId: string, goalId: string | undefined): void {
    if (this.candidates.get(sessionId) === goalId) return;
    if (goalId === undefined) this.candidates.delete(sessionId);
    else this.candidates.set(sessionId, goalId);
    const contents = JSON.stringify([...this.candidates].map(([sessionId, goalId]) => ({ sessionId, goalId })));
    this.writing = this.writing.catch(() => {}).then(async () => {
      const path = join(this.directory, 'goal-recovery.json');
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(contents); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    });
    void this.writing.catch(error => { this.report('index-write-failed', error); });
  }

  async prepareShutdown(): Promise<void> {
    this.stopping = true;
    for (const session of this.core.accessor.get(ISessionManager).list()) {
      const agents = session.accessor.get(IAgentLifecycleService);
      const main = agents.get('main');
      if (main) await agents.resolve(main, AgentGoal).prepareForRuntimeShutdown();
    }
    await this.writing;
  }

  async close(): Promise<void> {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    for (const id of this.sessions.keys()) this.detach(id);
    await this.writing;
  }

  private detach(id: string): void {
    for (const subscription of this.sessions.get(id) ?? []) subscription.dispose();
    this.sessions.delete(id);
  }

  private report(event: string, error: unknown, sessionId?: string): void {
    process.stderr.write(`${JSON.stringify({ event: `runtime.goal-recovery.${event}`, sessionId, message: error instanceof Error ? error.message : 'Recovery failed' })}\n`);
  }
}
