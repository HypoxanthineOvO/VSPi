import type { PolicyAction } from "../policy/execution-policy.js";
import type { LoadedWorkflowCore, WorkflowAdapter, WorkflowMilestoneSnapshot, WorkflowSnapshot } from "./types.js";

export function createHypoWorkflowAdapter(input: {
  workspace: string;
  loaded: LoadedWorkflowCore;
  clock?: () => string;
}): WorkflowAdapter {
  const clock = input.clock ?? (() => new Date().toISOString());
  let last: WorkflowSnapshot | undefined;

  return {
    async snapshot() {
      try {
        const resumed = record(
          await input.loaded.core.createDeliveryStore({ clock }).resume(input.workspace, {}),
          "Delivery resume result",
        );
        const delivery = record(resumed.delivery, "Delivery");
        const objectRef = record(delivery.object_ref, "Delivery object_ref");
        const milestones = Array.isArray(delivery.milestones) ? delivery.milestones.map((item) => milestone(item)) : [];
        const current = milestones.find((item) => ["executing", "pending_stone"].includes(item.status));
        last = {
          status: "ready",
          diagnostic: "Workflow Core ready",
          projection: { scope: "workspace", access: "read-only" },
          identity: { ...input.loaded.identity },
          delivery: {
            id: text(objectRef.id, "Delivery id"),
            kind: text(delivery.delivery_kind, "Delivery kind"),
            status: text(delivery.status, "Delivery status"),
            revision: integer(delivery.revision, "Delivery revision"),
            planHash: hash(delivery.plan_hash, "Delivery plan hash"),
            milestones,
            ...(current ? { currentMilestoneId: current.id } : {}),
          },
        };
        return structuredClone(last);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown Workflow error";
        const uninitialized = /manifest|workspace|delivery.*not found|no delivery/i.test(message);
        last = {
          status: uninitialized ? "uninitialized" : "error",
          diagnostic: uninitialized ? "Workflow 未初始化；请显式运行 /hw:init" : boundedDiagnostic(message),
          projection: { scope: "workspace", access: "read-only" },
          identity: { ...input.loaded.identity },
        };
        return structuredClone(last);
      }
    },
    async authorize(_action: PolicyAction) {
      last ??= await this.snapshot();
      // M1 has no Receipt-bearing mutation UI. All authority mutations remain denied.
      return false;
    },
  };
}

export function staticWorkflowAdapter(snapshot: WorkflowSnapshot): WorkflowAdapter {
  return {
    async snapshot() {
      return structuredClone(snapshot);
    },
    async authorize() {
      return false;
    },
  };
}

function milestone(value: unknown): WorkflowMilestoneSnapshot {
  const item = record(value, "Milestone");
  return {
    id: text(item.id, "Milestone id"),
    title: text(item.title, "Milestone title"),
    status: text(item.status, "Milestone status"),
    ...(item.stone === undefined ? {} : { stone: true }),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is invalid`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is invalid`);
  return Number(value);
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function boundedDiagnostic(value: string): string {
  return value.replace(/(?:\/[^\s/:]+){2,}/g, "[path]").slice(0, 300);
}
