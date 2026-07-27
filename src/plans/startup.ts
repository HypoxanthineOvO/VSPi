import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createLocalPlanBackend } from "./local-plan-backend.js";
import type { LocalPlanBackend } from "./types.js";

export function createStartupLocalPlanBackend(input: {
  workspace: string;
  agentDir?: string;
  recovery: boolean;
  workflow: boolean;
}): LocalPlanBackend | undefined {
  if (input.recovery || input.workflow) return undefined;
  const workspaceId = createHash("sha256").update(resolve(input.workspace)).digest("hex").slice(0, 20);
  return createLocalPlanBackend({
    rootDir: join(input.agentDir ?? getAgentDir(), "vspi-local-plans", workspaceId),
  });
}
