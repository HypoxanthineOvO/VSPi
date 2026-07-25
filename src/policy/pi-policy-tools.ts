import { resolve } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import type { ExecutionPolicyService, PolicyAction } from "./execution-policy.js";

type PolicyToolOverrides = {
  read: ReturnType<typeof createReadToolDefinition>;
  ls: ReturnType<typeof createLsToolDefinition>;
  find: ReturnType<typeof createFindToolDefinition>;
  grep: ReturnType<typeof createGrepToolDefinition>;
  bash: ReturnType<typeof createBashToolDefinition>;
  edit: ReturnType<typeof createEditToolDefinition>;
  write: ReturnType<typeof createWriteToolDefinition>;
};

export function createPolicyToolOverrides(options: {
  workspace: string;
  executionPolicy: Pick<ExecutionPolicyService, "evaluate">;
}): PolicyToolOverrides {
  const workspace = resolve(options.workspace);
  const native = {
    read: createReadToolDefinition(workspace),
    ls: createLsToolDefinition(workspace),
    find: createFindToolDefinition(workspace),
    grep: createGrepToolDefinition(workspace),
    bash: createBashToolDefinition(workspace),
    edit: createEditToolDefinition(workspace),
    write: createWriteToolDefinition(workspace),
  };

  return {
    read: guard(native.read, (input) => ({
      kind: "file-read",
      target: resolve(workspace, (input as { path: string }).path),
      category: "file-read",
      operation: "read",
    })),
    ls: guard(native.ls, (input) => ({
      kind: "file-read",
      target: resolve(workspace, (input as { path?: string }).path ?? "."),
      category: "file-read",
      operation: "list",
    })),
    find: guard(native.find, (input) => ({
      kind: "file-read",
      target: resolve(workspace, (input as { path?: string }).path ?? "."),
      category: "file-read",
      operation: "find",
    })),
    grep: guard(native.grep, (input) => ({
      kind: "file-read",
      target: resolve(workspace, (input as { path?: string }).path ?? "."),
      category: "file-read",
      operation: "grep",
    })),
    bash: guard(native.bash, (input) => classifyBash((input as { command: string }).command)),
    edit: guard(native.edit, (input) => ({
      kind: "file-write",
      target: resolve(workspace, (input as { path: string }).path),
      category: "file-write",
      operation: "edit",
    })),
    write: guard(native.write, (input) => ({
      kind: "file-write",
      target: resolve(workspace, (input as { path: string }).path),
      category: "file-write",
      operation: "write",
    })),
  };

  function guard<TParams extends TSchema, TDetails, TState>(
    tool: ToolDefinition<TParams, TDetails, TState>,
    actionFor: (input: Static<TParams>) => PolicyAction,
  ): ToolDefinition<TParams, TDetails, TState> {
    return {
      ...tool,
      async execute(toolCallId, input, signal, onUpdate, context) {
        const decision = await options.executionPolicy.evaluate(actionFor(input), signal);
        if (!decision.allowed) throw new Error(decision.reason);
        return tool.execute(toolCallId, input, signal, onUpdate, context);
      },
    };
  }
}

export function classifyBash(command: string): PolicyAction {
  const bounded = Array.from(command).slice(0, 240).join("");
  if (/\b(?:rm|rmdir|unlink|shred)\b|\bfind\b[^\n]*(?:-delete|-exec\s+rm)\b/i.test(command)) {
    return { kind: "process", target: bounded, risk: "high", category: "destructive", operation: "bash" };
  }
  if (/\b(?:docker|podman|kubectl|containerd|systemctl|service)\b/i.test(command)) {
    const system = /\b(?:systemctl|service)\b/i.test(command);
    return {
      kind: "process",
      target: bounded,
      risk: "high",
      category: system ? "system" : "container",
      operation: "bash",
    };
  }
  if (/\b(?:sudo|su|shutdown|reboot|poweroff|halt|mkfs|mount|umount|kill|pkill|killall)\b/i.test(command)) {
    return { kind: "process", target: bounded, risk: "high", category: "system", operation: "bash" };
  }
  if (/\bssh\b|\bscp\b|\brsync\b[^\n]*:/i.test(command)) {
    return { kind: "network", target: bounded, risk: "medium", category: "ssh", operation: "bash" };
  }
  if (/\bgit\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|switch|tag|stash|clean)\b/i.test(command)) {
    return { kind: "process", target: bounded, risk: "medium", category: "git-write", operation: "bash" };
  }
  if (
    /\b(?:curl|wget|http|https|npm\s+(?:install|publish)|pnpm\s+(?:add|install|publish)|yarn\s+add)\b/i.test(command)
  ) {
    return { kind: "network", target: bounded, risk: "medium", category: "network", operation: "bash" };
  }
  if (looksReadOnly(command)) {
    return { kind: "process", target: bounded, risk: "low", category: "bash-read", operation: "read" };
  }
  return { kind: "process", target: bounded, risk: "low", category: "process", operation: "bash" };
}

function looksReadOnly(command: string): boolean {
  if (/[>|]\s*(?:tee\b|[^|])/u.test(command) || /(?:^|\s)>>?\s*\S/u.test(command)) return false;
  const segments = command
    .split(/(?:&&|\|\||;|\n)/)
    .map((part) => part.trim())
    .filter(Boolean);
  return (
    segments.length > 0 &&
    segments.every((segment) => {
      const executable = segment.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:command\s+)?([\w./+-]+)/)?.[1];
      return (
        executable !== undefined &&
        [
          "cat",
          "head",
          "tail",
          "sed",
          "awk",
          "grep",
          "rg",
          "find",
          "fd",
          "ls",
          "pwd",
          "stat",
          "wc",
          "file",
          "which",
          "whereis",
          "type",
          "env",
          "printenv",
          "git",
          "npm",
          "pnpm",
          "yarn",
          "node",
          "tsx",
          "tsc",
        ].includes(executable.replace(/^.*\//, ""))
      );
    })
  );
}
