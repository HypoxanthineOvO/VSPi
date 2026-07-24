import { loadWorkflowCore, workflowLoaderOptionsFromEnv } from "./core-loader.js";
import { createHypoWorkflowAdapter, staticWorkflowAdapter } from "./hypo-adapter.js";
import type { WorkflowAdapter } from "./types.js";

export async function createStartupWorkflowAdapter(input: {
  enabled: boolean;
  workspace: string;
  env?: NodeJS.ProcessEnv;
  loadCore?: typeof loadWorkflowCore;
}): Promise<WorkflowAdapter> {
  if (!input.enabled) {
    return staticWorkflowAdapter({ status: "disabled", diagnostic: "Recovery 已禁用 Workflow Adapter" });
  }
  try {
    const options = workflowLoaderOptionsFromEnv(input.env);
    if (!options) {
      return staticWorkflowAdapter({
        status: "unavailable",
        diagnostic: "Workflow Core 未配置；需要完整的全局 bundle identity 配置",
      });
    }
    const loaded = await (input.loadCore ?? loadWorkflowCore)(options);
    return createHypoWorkflowAdapter({ workspace: input.workspace, loaded });
  } catch (error) {
    return staticWorkflowAdapter({
      status: "error",
      diagnostic: error instanceof Error ? error.message.slice(0, 300) : "Workflow Core 加载失败",
    });
  }
}
