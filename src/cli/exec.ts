import { homedir } from "node:os";
import { AdaptiveBackend } from "../backend/adaptive-backend.js";
import { resolveBackendMode } from "../backend/mode.js";
import { deepSeekHarnessEnabled } from "../config/deepseek-harness.js";
import type { TranscriptMessage } from "../domain/types.js";
import { createStartupGoalBackend } from "../goals/startup.js";
import { createStartupLocalPlanBackend } from "../plans/startup.js";
import { composeStartupPolicy } from "../policy/startup-compose.js";
import { createPromptProfileService } from "../prompts/profile-service.js";

/**
 * 非交互执行入口：`vspi exec "<prompt>"` 新会话执行单次 prompt；
 * `vspi exec resume "<prompt>"` 续接最近会话；`vspi exec resume <id> "<prompt>"`
 * 续接指定会话（id 支持唯一前缀）。`vspi run` 是兼容别名。
 * 全局 flag（--policy/--trust-project/--recovery/--workflow）可以从参数任意位置剥离。
 */

export interface ExecArguments {
  prompt: string;
  resume?: "latest" | { id: string };
}

const RESUME_KEYWORDS = new Set(["resume", "continue", "-c", "--continue", "--resume"]);
const GLOBAL_FLAGS_WITH_VALUE = new Set(["--policy"]);
const GLOBAL_BOOLEAN_FLAGS = new Set(["--trust-project", "--recovery", "--workflow"]);

function stripGlobalFlags(argv: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument) continue;
    if (GLOBAL_FLAGS_WITH_VALUE.has(argument)) {
      index += 1; // 消费 --policy 的取值
      continue;
    }
    if (argument.startsWith("--policy=")) continue;
    if (GLOBAL_BOOLEAN_FLAGS.has(argument)) continue;
    result.push(argument);
  }
  return result;
}

export function parseExecArguments(argv: string[]): ExecArguments | { error: string } {
  const arguments_ = stripGlobalFlags(argv.filter((argument) => argument.trim().length > 0));
  if (arguments_.length === 0) {
    return { error: '用法：vspi exec [resume [<session-id>]] "<prompt>"（vspi run 是兼容别名）' };
  }
  const first = arguments_[0];
  if (first === undefined || !RESUME_KEYWORDS.has(first)) {
    return { prompt: arguments_.join(" ") };
  }
  const second = arguments_[1];
  if (second === undefined) {
    return { error: '用法：vspi exec resume [<session-id>] "<prompt>"' };
  }
  if (second === "latest") {
    const prompt = arguments_.slice(2).join(" ").trim();
    if (!prompt) return { error: '用法：vspi exec resume latest "<prompt>"' };
    return { prompt, resume: "latest" };
  }
  if (arguments_.length === 2) return { prompt: second, resume: "latest" };
  return { prompt: arguments_.slice(2).join(" "), resume: { id: second } };
}

async function resolveSessionId(backend: AdaptiveBackend, id: string): Promise<string> {
  const sessions = await backend.listSessions();
  const exact = sessions.find((session) => session.id === id);
  if (exact) return exact.id;
  const prefixed = sessions.filter((session) => session.id.startsWith(id));
  if (prefixed.length === 1) {
    const match = prefixed[0];
    if (match) return match.id;
  }
  if (prefixed.length > 1) throw new Error(`会话前缀 ${id} 匹配到多个会话；请使用完整 session id`);
  throw new Error(`找不到会话 ${id}；可在 TUI 中运行 /sessions 查看会话 id，或使用 vspi exec resume 续接最近会话`);
}

export async function runExec(argv: string[]): Promise<void> {
  const parsed = parseExecArguments(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    await executeOnce(parsed);
  } catch (error) {
    process.stderr.write(`vspi exec 失败：${error instanceof Error ? error.message : "未知错误"}\n`);
    process.exitCode = 1;
  }
}

async function executeOnce(parsed: ExecArguments): Promise<void> {
  const prompt = parsed.prompt.trim();
  if (!prompt) throw new Error('用法：vspi exec [resume [<session-id>]] "<prompt>"');
  const workspace = process.cwd();
  const { security, executionPolicy, workflowAdapter } = await composeStartupPolicy(workspace);
  const promptProfileService = createPromptProfileService({
    cwd: workspace,
    home: process.env.HOME ?? homedir(),
    trustedProject: security.trustedProject,
  });
  await promptProfileService.load();
  const localPlanBackend = createStartupLocalPlanBackend({
    workspace,
    recovery: security.recovery,
    workflow: security.workflowAdapter,
  });
  const goalBackend = createStartupGoalBackend({
    workspace,
    recovery: security.recovery,
    workflow: security.workflowAdapter,
  });
  const backend = new AdaptiveBackend(
    workspace,
    resolveBackendMode(),
    security.trustedProject,
    security.recovery,
    executionPolicy,
    localPlanBackend,
    { resolve: async (identity) => promptProfileService.resolve(identity) },
    {
      // resume 需要已有会话；新会话模式保持 false，避免误续接。
      continueRecent: parsed.resume !== undefined,
      deepSeekHarness: deepSeekHarnessEnabled(),
      ...(security.workflowAdapter ? { workflowPlan: workflowAdapter } : {}),
    },
    goalBackend,
  );
  const messages: TranscriptMessage[] = [];
  try {
    await backend.start({
      onMessage: (message) => {
        messages.push(message);
      },
      onMessageUpdate: (id, patch) => {
        const index = messages.findIndex((message) => message.id === id);
        const current = messages[index];
        if (index >= 0 && current) messages[index] = { ...current, ...patch } as TranscriptMessage;
      },
      onBusy: () => {},
      onUsage: () => {},
      onNotice: (text) => {
        process.stderr.write(`${text}\n`);
      },
      onSessionInvalidating: () => {},
      onSessionReset: () => {},
    });
    if (parsed.resume && parsed.resume !== "latest") {
      const sessionId = await resolveSessionId(backend, parsed.resume.id);
      await backend.switchSession(sessionId);
    }
    const result = await backend.send(prompt, { attachments: [], effort: "medium", behavior: "prompt" });
    const reply = [...messages].reverse().find((message) => message.role === "assistant" && message.kind === "text");
    if (reply && reply.kind === "text" && reply.text.trim()) process.stdout.write(`${reply.text}\n`);
    if (result && result.status === "cancelled") process.exitCode = 130;
  } finally {
    await backend.dispose();
  }
}
