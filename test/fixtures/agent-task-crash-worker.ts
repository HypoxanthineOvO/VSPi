import { writeFile } from "node:fs/promises";
import { AgentTaskRuntime } from "../../src/agents/task-runtime.js";

const directory = process.argv[2];
const ready = process.argv[3];
if (!directory || !ready) throw new Error("worker requires directory and ready path");
const runtime = await AgentTaskRuntime.open({ directory });
await runtime.register({
  taskId: "agent-crash0001",
  agentId: "crash-child",
  ownerAgentId: "main",
  description: "crash fixture",
  detached: true,
});
await runtime.appendOutput("agent-crash0001", "before crash");
await writeFile(ready, "ready");
await new Promise(() => {});
