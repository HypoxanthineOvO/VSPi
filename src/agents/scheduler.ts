import { randomUUID } from "node:crypto";

export const DEFAULT_AGENT_MAX_DEPTH = 3;
export const DEFAULT_AGENT_MAX_PER_TREE = 12;
export const DEFAULT_AGENT_MAX_CONCURRENCY = 16;

interface TreeState {
  created: number;
  cancelled: boolean;
  controller: AbortController;
  consumedTokens: number;
  consumedCostUsd: number;
  fingerprints: Set<string>;
}

export interface AgentTreeContext {
  treeId: string;
  depth: number;
  runId?: string;
  parentRunId?: string;
  lease?: AgentGenerationLease;
}

export class AgentGenerationLease {
  private active = false;
  private suspensionCount = 0;

  constructor(private readonly semaphore: Semaphore) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.active || this.suspensionCount > 0) return;
    await this.semaphore.acquire(signal);
    this.active = true;
  }

  suspend(): void {
    this.suspensionCount += 1;
    if (!this.active) return;
    this.active = false;
    this.semaphore.release();
  }

  async resume(signal?: AbortSignal): Promise<void> {
    if (this.suspensionCount === 0) return;
    this.suspensionCount -= 1;
    if (this.suspensionCount === 0) await this.acquire(signal);
  }

  release(): void {
    this.suspensionCount = 0;
    if (!this.active) return;
    this.active = false;
    this.semaphore.release();
  }
}

export class AgentTreeScheduler {
  private readonly semaphore: Semaphore;
  private readonly writerSemaphore = new Semaphore(1);
  private readonly trees = new Map<string, TreeState>();

  constructor(
    readonly maxConcurrency = DEFAULT_AGENT_MAX_CONCURRENCY,
    readonly maxDepth = DEFAULT_AGENT_MAX_DEPTH,
    readonly maxAgentsPerTree = DEFAULT_AGENT_MAX_PER_TREE,
    readonly maxTreeTokens = 500_000,
    readonly maxTreeCostUsd = 20,
  ) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("Agent maxConcurrency must be a positive integer");
    }
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 5)
      throw new Error("Agent maxDepth must be an integer between 1 and 5");
    if (!Number.isSafeInteger(maxTreeTokens) || maxTreeTokens < 1_000)
      throw new Error("Agent maxTreeTokens must be an integer of at least 1000");
    if (!Number.isFinite(maxTreeCostUsd) || maxTreeCostUsd <= 0)
      throw new Error("Agent maxTreeCostUsd must be positive");
    // C19 P0-2：并发数只控制同时在跑的 generation 数（配置仍约束 semaphore），
    // 不再作为拒绝 spawn 的理由——超过并发的请求排队等待而不是失败。
    this.semaphore = new Semaphore(maxConcurrency);
  }

  root(): AgentTreeContext {
    const treeId = randomUUID();
    this.trees.set(treeId, {
      created: 0,
      cancelled: false,
      controller: new AbortController(),
      consumedTokens: 0,
      consumedCostUsd: 0,
      fingerprints: new Set(),
    });
    return { treeId, depth: 0 };
  }

  child(parent: AgentTreeContext, runId: string, fingerprint?: string): AgentTreeContext {
    const tree = this.requireTree(parent.treeId);
    if (tree.cancelled) throw abortError("Agent tree was cancelled");
    // C19 P0-2：预算与 per-parent child/tree size 不再构成拒绝条件，仅保留深度限制；
    // 深度超限只禁止继续 spawn，不影响已有 agent 运行（默认 3，可配置）。
    const depth = parent.depth + 1;
    if (depth > this.maxDepth) throw new Error(`Agent depth limit exceeded (${this.maxDepth})`);
    if (fingerprint && tree.fingerprints.has(fingerprint)) throw new Error("Duplicate agent task in the same tree");
    tree.created += 1;
    if (fingerprint) tree.fingerprints.add(fingerprint);
    return {
      treeId: parent.treeId,
      depth,
      runId,
      ...(parent.runId ? { parentRunId: parent.runId } : {}),
    };
  }

  createLease(): AgentGenerationLease {
    return new AgentGenerationLease(this.semaphore);
  }

  async withWriter<T>(writeAccess: boolean, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!writeAccess) return operation();
    await this.writerSemaphore.acquire(signal);
    try {
      return await operation();
    } finally {
      this.writerSemaphore.release();
    }
  }

  treeSignal(treeId: string): AbortSignal {
    return this.requireTree(treeId).controller.signal;
  }

  recordUsage(treeId: string, tokens: number, costUsd: number): void {
    const tree = this.requireTree(treeId);
    tree.consumedTokens += Math.max(0, Math.round(tokens));
    tree.consumedCostUsd += Math.max(0, costUsd);
  }

  budget(treeId: string): { tokens: number; costUsd: number } {
    const tree = this.requireTree(treeId);
    return { tokens: tree.consumedTokens, costUsd: tree.consumedCostUsd };
  }

  cancelTree(treeId: string): void {
    const tree = this.trees.get(treeId);
    if (tree) {
      tree.cancelled = true;
      tree.controller.abort();
    }
  }

  finishTree(treeId: string): void {
    this.trees.delete(treeId);
  }

  private requireTree(treeId: string): TreeState {
    const tree = this.trees.get(treeId);
    if (!tree) throw new Error("Agent tree is no longer active");
    return tree;
  }
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }> = [];

  constructor(private readonly limit: number) {}

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError("Agent start was cancelled"));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError("Agent start was cancelled"));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (!next) {
      this.active = Math.max(0, this.active - 1);
      return;
    }
    if (next.signal && next.abort) next.signal.removeEventListener("abort", next.abort);
    next.resolve();
  }
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
