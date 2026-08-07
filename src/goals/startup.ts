import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createGoalBackend } from "./backend.js";
import type { GoalBackend } from "./types.js";

export function createStartupGoalBackend(input: {
  workspace: string;
  agentDir?: string;
  recovery: boolean;
  workflow: boolean;
}): GoalBackend | undefined {
  if (input.recovery || input.workflow) return undefined;
  const workspaceId = createHash("sha256").update(resolve(input.workspace)).digest("hex").slice(0, 20);
  return createGoalBackend({ rootDir: join(input.agentDir ?? getAgentDir(), "vspi-goals", workspaceId) });
}
