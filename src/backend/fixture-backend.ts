import { randomUUID } from "node:crypto";
import { DEFAULT_USAGE } from "../domain/defaults.js";
import type { EffortLevel, TextMessage } from "../domain/types.js";
import type {
  CancelResult,
  ChatBackend,
  ChatBackendEvents,
  NewSessionOptions,
  ProviderProbeMode,
  RuntimeModelOption,
  SendOptions,
  SendResult,
} from "./types.js";

export class FixtureBackend implements ChatBackend {
  readonly kind = "fixture" as const;
  readonly modelLabel = "Offline Fixture";
  readonly modelId = "offline-fixture";
  readonly modelProvider = "fixture";
  readonly supportsVision = true;
  private events?: ChatBackendEvents;
  private cancelled = false;
  private running = false;
  private steeringQueue: Array<{ text: string; options: SendOptions }> = [];
  private followUpQueue: Array<{ text: string; options: SendOptions }> = [];
  private sessionId: string = randomUUID();

  async start(events: ChatBackendEvents): Promise<void> {
    this.events = events;
    events.onSessionReset?.({ id: this.sessionId, reason: "startup" });
    events.onUsage(DEFAULT_USAGE);
  }

  async send(text: string, options: SendOptions): Promise<SendResult> {
    if (!this.events) throw new Error("Fixture backend has not started");
    if (this.running) {
      const delivery = options.behavior === "followUp" ? "followUp" : "steer";
      const queue = delivery === "followUp" ? this.followUpQueue : this.steeringQueue;
      queue.push({ text, options });
      this.publishQueue();
      return { status: "queued", delivery };
    }
    this.cancelled = false;
    this.running = true;
    this.events.onBusy(true);
    let current: { text: string; options: SendOptions } | undefined = { text, options };
    while (current && !this.cancelled) {
      await this.emitResponse(current.text, current.options);
      current = this.steeringQueue.shift() ?? this.followUpQueue.shift();
      this.publishQueue();
    }
    this.running = false;
    this.events.onBusy(false);
    return { status: this.cancelled ? "cancelled" : "completed" };
  }

  private async emitResponse(text: string, options: SendOptions): Promise<void> {
    if (!this.events) return;
    const id = randomUUID();
    const attachmentNote =
      options.attachments.length > 0
        ? `\n\n已接收 ${options.attachments.map((item) => `\`${item.alias}\``).join("、")}。`
        : "";
    const response = [
      "## Fixture 回应",
      "",
      `当前以 **${options.effort}** effort 处理：${text}`,
      attachmentNote,
      "",
      "- 真实会话适配层可用",
      "  - Fixture 仅通过显式离线入口启用",
      "    - 所有交互状态仍可验证",
      "",
      "> 这是本地 fixture，不会发送网络请求。",
    ].join("\n");
    const message: TextMessage = { id, role: "assistant", kind: "text", text: "", streaming: true };
    this.events.onMessage(message);
    for (let offset = 0; offset < response.length && !this.cancelled; offset += 12) {
      message.text = response.slice(0, offset + 12);
      this.events.onMessageUpdate(id, { text: message.text, streaming: true });
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    this.events.onMessageUpdate(id, { text: message.text, streaming: false });
  }

  async cancel(): Promise<CancelResult> {
    const queuedMessages = [...this.steeringQueue, ...this.followUpQueue].map((item) => item.text);
    this.steeringQueue = [];
    this.followUpQueue = [];
    this.cancelled = true;
    this.running = false;
    this.publishQueue();
    this.events?.onBusy(false);
    return { queuedMessages };
  }

  private publishQueue(): void {
    this.events?.onQueueUpdate?.({ steering: this.steeringQueue.length, followUp: this.followUpQueue.length });
  }

  async compact(): Promise<void> {
    this.events?.onNotice("上下文已由 fixture 压缩", "success");
  }

  async newSession(options?: NewSessionOptions): Promise<void> {
    this.sessionId = randomUUID();
    this.events?.onSessionReset?.({
      id: this.sessionId,
      reason: "new",
      ...(options ? { continuePlan: options.continuePlan } : {}),
    });
    this.events?.onUsage(DEFAULT_USAGE);
    this.events?.onNotice("已新建 fixture 会话", "success");
  }

  async listSessions() {
    return [];
  }

  async switchSession(id: string): Promise<void> {
    this.sessionId = id;
    this.events?.onSessionReset?.({ id, reason: "resume" });
    this.events?.onUsage(DEFAULT_USAGE);
    this.events?.onNotice(`已切换到会话 ${id}`, "success");
  }

  async forkSession(id: string): Promise<void> {
    this.sessionId = randomUUID();
    this.events?.onSessionReset?.({ id: this.sessionId, reason: "fork" });
    this.events?.onUsage(DEFAULT_USAGE);
    this.events?.onNotice(`已从会话 ${id} 创建离线分支`, "success");
  }

  async getModelOptions(): Promise<RuntimeModelOption[]> {
    return [
      {
        id: this.modelId,
        provider: "fixture",
        brand: "Fixture",
        label: this.modelLabel,
        vision: true,
        efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as EffortLevel[],
        price: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
        contextWindow: 0,
      },
    ];
  }

  async getModelGroups() {
    return [];
  }

  async getProviderOptions() {
    return [
      {
        id: "offline-fixture",
        label: "Offline Fixture",
        protocol: "Local deterministic",
        status: "已配置" as const,
        detail: "显式离线模式 · 无网络 · 无 credential",
      },
    ];
  }

  async selectModel(provider: string, id: string) {
    if (provider !== "fixture" || id !== this.modelId) throw new Error("Fixture 仅提供 Offline Fixture 模型");
    return { modelId: id, vision: true, contextWindow: 0, profileModelId: id, effort: "medium" as const };
  }

  async getEffortOptions(): Promise<EffortLevel[]> {
    return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  }

  async setEffort(): Promise<void> {}

  isProjectTrusted(): boolean {
    return false;
  }

  async runProviderProbe(_providerId: string, mode: ProviderProbeMode) {
    return mode === "check-config"
      ? { ok: true, diagnostic: "Offline Fixture 配置有效；未发起网络请求" }
      : { ok: false, diagnostic: "Offline Fixture 不执行网络或付费探测" };
  }

  async dispose(): Promise<void> {
    this.cancelled = true;
  }
}
