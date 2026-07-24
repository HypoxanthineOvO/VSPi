import { resolve } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ExecutionPolicyService, PolicyAction, PolicyExecutionResult } from "./execution-policy.js";

type PolicyToolOverrides = {
  read: ReturnType<typeof createReadToolDefinition>;
  bash: ReturnType<typeof createBashToolDefinition>;
  edit: ReturnType<typeof createEditToolDefinition>;
  write: ReturnType<typeof createWriteToolDefinition>;
};

export function createPolicyToolOverrides(options: {
  workspace: string;
  executionPolicy: Pick<ExecutionPolicyService, "execute">;
}): PolicyToolOverrides {
  const workspace = resolve(options.workspace);
  const native = {
    read: createReadToolDefinition(workspace),
    bash: createBashToolDefinition(workspace),
    edit: createEditToolDefinition(workspace),
    write: createWriteToolDefinition(workspace),
  };

  const read: PolicyToolOverrides["read"] = {
    ...native.read,
    async execute(_toolCallId, input, signal) {
      const value = input as { path: string; offset?: number; limit?: number };
      const path = resolve(workspace, value.path);
      const result = await options.executionPolicy.execute({
        action: { kind: "file-read", target: path },
        command: process.execPath,
        args: ["-e", READ_SCRIPT, path, String(value.offset ?? ""), String(value.limit ?? "")],
        cwd: workspace,
        ...(signal ? { signal } : {}),
      });
      return toolResult(result, `Read ${value.path}`);
    },
  };

  const write: PolicyToolOverrides["write"] = {
    ...native.write,
    async execute(_toolCallId, input, signal) {
      const value = input as { path: string; content: string };
      const path = resolve(workspace, value.path);
      const result = await options.executionPolicy.execute({
        action: { kind: "file-write", target: path },
        command: process.execPath,
        args: ["-e", WRITE_SCRIPT, path],
        cwd: workspace,
        env: { VSPI_TOOL_CONTENT: value.content },
        ...(signal ? { signal } : {}),
      });
      return toolResult(result, `Successfully wrote ${value.path}`);
    },
  };

  const edit: PolicyToolOverrides["edit"] = {
    ...native.edit,
    async execute(_toolCallId, input, signal) {
      const value = input as { path: string; edits: Array<{ oldText: string; newText: string }> };
      const path = resolve(workspace, value.path);
      const result = await options.executionPolicy.execute({
        action: { kind: "file-write", target: path, operation: "edit" },
        command: process.execPath,
        args: ["-e", EDIT_SCRIPT, path],
        cwd: workspace,
        env: { VSPI_TOOL_EDITS: JSON.stringify(value.edits) },
        ...(signal ? { signal } : {}),
      });
      return toolResult(result, `Successfully edited ${value.path}`);
    },
  };

  const bash: PolicyToolOverrides["bash"] = {
    ...native.bash,
    async execute(_toolCallId, input, signal, onUpdate) {
      const value = input as { command: string; timeout?: number };
      const action = classifyBash(value.command);
      const result = await options.executionPolicy.execute({
        action,
        command: "/bin/bash",
        args: ["-lc", value.command],
        cwd: workspace,
        ...(signal ? { signal } : {}),
        ...(value.timeout !== undefined ? { timeoutMs: value.timeout } : {}),
      });
      const output = toolResult(result, "(no output)");
      onUpdate?.(output);
      return output;
    },
  };

  return { read, bash, edit, write };
}

function classifyBash(command: string): PolicyAction {
  const url = command.match(/https?:\/\/[^\s'"`|;]+/i)?.[0];
  if (url) return { kind: "network", target: url };
  const highRisk = /\b(?:sudo|mkfs|mount|umount|chown|chmod|kill|pkill|git\s+push)\b|\brm\s+-[^\n]*r/i.test(command);
  return { kind: "process", target: bounded(command), risk: highRisk ? "high" : "low" };
}

function toolResult(result: PolicyExecutionResult, fallback: string) {
  if (!result.started || result.exitCode !== 0) {
    throw new Error([result.decision.reason, result.stderr].filter(Boolean).join("\n"));
  }
  return {
    content: [{ type: "text" as const, text: result.stdout || fallback }],
    details: undefined,
  };
}

function bounded(value: string): string {
  return Array.from(value).slice(0, 160).join("");
}

const READ_SCRIPT = String.raw`
const fs = require("node:fs");
const path = process.argv[1];
const offset = Number(process.argv[2] || 1);
const limit = process.argv[3] ? Number(process.argv[3]) : undefined;
const buffer = fs.readFileSync(path);
if (!limit && offset <= 1) process.stdout.write(buffer);
else {
  const lines = buffer.toString("utf8").split("\n");
  process.stdout.write(lines.slice(Math.max(0, offset - 1), limit ? Math.max(0, offset - 1) + limit : undefined).join("\n"));
}`;

const WRITE_SCRIPT = `
require("node:fs").writeFileSync(process.argv[1], process.env.VSPI_TOOL_CONTENT || "");
process.stdout.write("write ok");`;

const EDIT_SCRIPT = `
const fs = require("node:fs");
const path = process.argv[1];
const edits = JSON.parse(process.env.VSPI_TOOL_EDITS || "[]");
let content = fs.readFileSync(path, "utf8");
for (const edit of edits) {
  const first = content.indexOf(edit.oldText);
  if (first < 0 || content.indexOf(edit.oldText, first + edit.oldText.length) >= 0) throw new Error("oldText must match exactly once");
  content = content.slice(0, first) + edit.newText + content.slice(first + edit.oldText.length);
}
fs.writeFileSync(path, content);
process.stdout.write("edit ok");`;
