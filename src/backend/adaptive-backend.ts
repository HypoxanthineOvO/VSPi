import type { CompactOptions } from "../continuity/compaction-profiles.js";
import type { EffortLevel, ModelGroup, ProviderOption, SessionOption } from "../domain/types.js";
import type { LocalPlanBackend } from "../plans/types.js";
import type { ExecutionPolicyService } from "../policy/execution-policy.js";
import type { ModelIdentity, ResolvedPromptProfile } from "../prompts/types.js";
import { FixtureBackend } from "./fixture-backend.js";
import { PiBackend } from "./pi-backend.js";
import type {
  ChatBackend,
  ChatBackendEvents,
  ModelSelectionResult,
  NewSessionOptions,
  ProviderProbeMode,
  RuntimeModelOption,
  SendOptions,
  SendResult,
} from "./types.js";

export type BackendMode = "pi" | "fixture";

export class AdaptiveBackend implements ChatBackend {
  private active: ChatBackend;

  constructor(
    cwd: string,
    mode: BackendMode = "pi",
    trustedProject = false,
    recovery = false,
    executionPolicy?: ExecutionPolicyService,
    planBackend?: LocalPlanBackend,
    promptProfiles?: {
      resolve(identity: ModelIdentity): Promise<Pick<ResolvedPromptProfile, "profileId" | "overlay">>;
    },
    startup?: { continueRecent?: boolean },
  ) {
    this.active =
      mode === "fixture"
        ? new FixtureBackend()
        : new PiBackend({
            cwd,
            continueRecent: startup?.continueRecent ?? false,
            trustedProject,
            recovery,
            ...(planBackend ? { planBackend } : {}),
            ...(promptProfiles ? { promptProfiles } : {}),
            ...(executionPolicy ? { executionPolicy } : {}),
          });
  }

  get kind(): "fixture" | "pi" {
    return this.active.kind;
  }

  get modelLabel(): string {
    return this.active.modelLabel;
  }

  get modelId(): string {
    return this.active.modelId;
  }

  get modelProvider(): string | undefined {
    return this.active.modelProvider;
  }

  get supportsVision(): boolean {
    return this.active.supportsVision;
  }

  async start(events: ChatBackendEvents): Promise<void> {
    await this.active.start(events);
  }

  // biome-ignore lint/suspicious/noConfusingVoidType: delegates the compatibility return type unchanged.
  async send(text: string, options: SendOptions): Promise<void | SendResult> {
    return this.active.send(text, options);
  }

  async cancel() {
    return this.active.cancel();
  }

  async compact(options?: CompactOptions): Promise<void> {
    await this.active.compact(options);
  }

  abortCompaction(): void {
    this.active.abortCompaction?.();
  }

  async newSession(options?: NewSessionOptions): Promise<void> {
    await this.active.newSession(options);
  }

  async listSessions(): Promise<SessionOption[]> {
    return this.active.listSessions();
  }

  async switchSession(id: string): Promise<void> {
    await this.active.switchSession(id);
  }

  async forkSession(id: string): Promise<void> {
    if (!this.active.forkSession) throw new Error("当前后端不支持会话分支");
    await this.active.forkSession(id);
  }

  getPlanBinding() {
    return this.active.getPlanBinding?.();
  }

  async bindPlan(planId: string | undefined): Promise<void> {
    if (!this.active.bindPlan) throw new Error("当前后端不支持 Local Plan 绑定");
    await this.active.bindPlan(planId);
  }

  getEffectivePromptSegments() {
    return this.active.getEffectivePromptSegments?.() ?? [];
  }

  async getModelOptions(): Promise<RuntimeModelOption[]> {
    return this.active.getModelOptions?.() ?? [];
  }

  async getModelGroups(): Promise<ModelGroup[]> {
    return this.active.getModelGroups?.() ?? [];
  }

  async getProviderOptions(): Promise<ProviderOption[]> {
    return this.active.getProviderOptions?.() ?? [];
  }

  async selectModel(provider: string, id: string): Promise<ModelSelectionResult> {
    if (!this.active.selectModel) throw new Error("当前后端不支持模型切换");
    return this.active.selectModel(provider, id);
  }

  async getEffortOptions(): Promise<EffortLevel[]> {
    return this.active.getEffortOptions?.() ?? ["medium"];
  }

  async setEffort(level: EffortLevel): Promise<void> {
    if (!this.active.setEffort) throw new Error("当前后端不支持 Effort 切换");
    await this.active.setEffort(level);
  }

  isProjectTrusted(): boolean {
    return this.active.isProjectTrusted?.() ?? false;
  }

  async runProviderProbe(
    providerId: string,
    mode: ProviderProbeMode,
    confirmCost?: () => Promise<boolean>,
  ): Promise<{ ok: boolean; diagnostic: string }> {
    if (!this.active.runProviderProbe) return { ok: false, diagnostic: "当前后端不支持 Provider probe" };
    return this.active.runProviderProbe(providerId, mode, confirmCost);
  }

  async dispose(): Promise<void> {
    await this.active.dispose();
  }
}
