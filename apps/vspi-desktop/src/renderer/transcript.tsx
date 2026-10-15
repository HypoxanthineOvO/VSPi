import { memo, useMemo } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";
import type { AgentHistoryPage, AgentToolTaskView } from "../shared.js";
import { Markdown } from "./markdown";

type Item = AgentHistoryPage["items"][number];
type Part = Item["content"][number];
type ToolCall = Item["toolCalls"][number];
type Display = NonNullable<Item["toolCallDisplays"]>[string];

interface Row {
  key: string;
  kind: "user" | "assistant" | "thinking" | "tools" | "notice";
  text?: string;
  tools?: ToolRow[];
  durationMs?: number;
}
interface ToolRow {
  id: string;
  call: ToolCall;
  display?: Display;
  result?: string;
  error?: boolean;
  durationMs?: number;
  pending: boolean;
}

const INJECTED_BLOCK =
  /<system-reminder>[\s\S]*?<\/system-reminder>|<notification\b[\s\S]*?<\/notification>/g;

function textOf(item: Item): string {
  return item.content
    .filter((part): part is Part & { type: "text" } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .replace(INJECTED_BLOCK, "")
    .trim();
}

function userVisible(item: Item): boolean {
  const origin = item.origin;
  if (origin === undefined) return true;
  switch (origin.kind) {
    case "user":
    case "skill_activation":
    case "plugin_command":
      return true;
    case "shell_command":
      return origin.phase === "input";
    default:
      return false;
  }
}
function thinkOf(item: Item): string {
  return item.content
    .filter((part): part is Part & { type: "think" } => part.type === "think")
    .map((part) => part.think)
    .join("\n")
    .trim();
}

function toolResultText(item: Item | undefined): string | undefined {
  if (!item) return undefined;
  const text = textOf(item);
  return text || undefined;
}

function titleOf(call: ToolCall): string {
  try {
    const args = call.arguments ? JSON.parse(call.arguments) : undefined;
    if (args && typeof args === "object") {
      const record = args as Record<string, unknown>;
      const first = ["command", "path", "file_path", "pattern", "url", "task", "description"]
        .map((key) => record[key])
        .find((value) => typeof value === "string");
      if (typeof first === "string") return first.split("\n")[0]!.slice(0, 120);
    }
  } catch {
    // fall through to the raw name
  }
  return call.name;
}

export function projectRows(items: readonly Item[]): Row[] {
  const rows: Row[] = [];
  const pendingTools = new Map<string, ToolRow>();
  const flushPending = () => {
    if (pendingTools.size === 0) return;
    rows.push({
      key: `tools:${rows.length}`,
      kind: "tools",
      tools: [...pendingTools.values()],
    });
    pendingTools.clear();
  };
  items.forEach((item, index) => {
    const key = item.id ?? `item:${index}`;
    if (item.role === "system") return;
    if (item.role === "user") {
      flushPending();
      if (!userVisible(item)) return;
      const text = textOf(item);
      if (text)
        rows.push({ key, kind: "user", text, durationMs: item.durationMs });
      return;
    }
    if (item.role === "tool") {
      const callId = item.toolCallId ?? "";
      const result = toolResultText(item);
      const row = pendingTools.get(callId);
      if (row) {
        row.result = result;
        row.error = item.isError === true;
        row.durationMs = item.durationMs;
        row.pending = false;
      }
      return;
    }
    if (item.role === "assistant") {
      flushPending();
      const thinking = thinkOf(item);
      if (thinking)
        rows.push({
          key: `${key}:think`,
          kind: "thinking",
          text: thinking,
          durationMs: item.durationMs,
        });
      const text = textOf(item);
      if (text)
        rows.push({
          key: `${key}:text`,
          kind: "assistant",
          text,
          durationMs: item.durationMs,
        });
      for (const call of item.toolCalls) {
        pendingTools.set(call.id, {
          id: call.id,
          call,
          display: item.toolCallDisplays?.[call.id],
          pending: true,
        });
      }
      return;
    }
  });
  flushPending();
  return rows;
}

function elapsed(ms?: number): string {
  if (ms === undefined || ms < 0) return "";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const UserRow = memo(function UserRow({ row }: { row: Row }) {
  return (
    <div className="vspi-user-surface rounded-xl px-3 py-2 text-ui-base/relaxed whitespace-pre-wrap">
      {row.text}
    </div>
  );
});

const ThinkingRow = memo(function ThinkingRow({ row }: { row: Row }) {
  return (
    <details className="vspi-thinking group rounded-md py-1 pl-3 text-ui-caption">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-foreground-subtle select-none">
        <ChevronDownIcon className="size-3 transition-transform group-open:rotate-0 -rotate-90" />
        <span>思考</span>
        {row.durationMs !== undefined && (
          <span className="text-foreground-subtlest">
            · {elapsed(row.durationMs)}
          </span>
        )}
      </summary>
      <div className="mt-1 whitespace-pre-wrap opacity-80">{row.text}</div>
    </details>
  );
});

function toolTitle(
  row: ToolRow,
  agentTasks?: Record<string, AgentToolTaskView>,
): string {
  const display = row.display;
  switch (display?.kind) {
    case "command":
      return `Bash ${display.command}`;
    case "file_io":
      return `${row.call.name} ${display.path}`;
    case "diff":
      return `${row.call.name} ${display.path}`;
    case "search":
      return `${row.call.name} ${display.query}`;
    case "url_fetch":
      return `${row.call.name} ${display.url}`;
    case "agent_call":
      break;
    default:
      if (row.call.name !== "Agent")
        return `${row.call.name} ${titleOf(row.call) === row.call.name ? "" : titleOf(row.call)}`.trim();
  }
  if (row.call.name === "Agent") {
    const task = agentTasks?.[row.id];
    if (task !== undefined)
      return `Agent ${[
        task.description,
        task.subagentType,
        task.model?.split("/").at(-1),
      ]
        .filter((part) => part !== undefined && part.length > 0)
        .join(" · ")}`;
    if (display?.kind === "agent_call")
      return `Agent ${display.agent_name} · ${display.prompt.split("\n")[0]!.slice(0, 80)}`;
    const args = titleOf(row.call);
    return `Agent${args === "Agent" ? "" : ` ${args}`}`;
  }
  return row.call.name;
}

const AGENT_RECEIPT_LINE =
  /^(?:task_id|agent_id|status|stop_reason|actual_subagent_type|automatic_notification|description|next_step|resume_hint|note):/i;

function toolOutcomeLine(
  tool: ToolRow,
  agentOutputs?: Record<string, string>,
): string | undefined {
  if (tool.call.name !== "Agent")
    return tool.result
      ?.split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
  const output = agentOutputs?.[tool.id];
  if (output !== undefined) {
    const line = output
      .split("\n")
      .map((value) => value.trim())
      .find((value) => value.length > 0);
    if (line !== undefined) return line;
  }
  if (!tool.result) return undefined;
  const lines = tool.result.split("\n").map((line) => line.trim());
  const marker = lines.findIndex((line) => line === "[summary]");
  const candidates = marker >= 0 ? lines.slice(marker + 1) : lines;
  return candidates.find(
    (line) => line.length > 0 && !AGENT_RECEIPT_LINE.test(line),
  );
}

const ToolGroupRow = memo(function ToolGroupRow({
  row,
  agentOutputs,
  agentTasks,
}: {
  row: Row;
  agentOutputs?: Record<string, string>;
  agentTasks?: Record<string, AgentToolTaskView>;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {row.tools?.map((tool) => {
        const outcome = !tool.pending
          ? toolOutcomeLine(tool, agentOutputs)
          : undefined;
        return (
          <div key={tool.id} className="text-ui-caption">
            <div className="flex min-w-0 items-center gap-1.5 text-foreground">
              {tool.pending ? (
                <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
              ) : tool.error ? (
                <XIcon className="size-3.5 shrink-0 text-destructive" />
              ) : (
                <CheckIcon className="size-3.5 shrink-0 text-success" />
              )}
              <span className="truncate">{toolTitle(tool, agentTasks)}</span>
              {tool.durationMs !== undefined && (
                <span className="shrink-0 text-foreground-subtlest">
                  · {elapsed(tool.durationMs)}
                </span>
              )}
            </div>
            {outcome !== undefined && (
              <div className="truncate pl-5 text-foreground-subtle">
                → {outcome.slice(0, 160)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

export const Transcript = memo(function Transcript({
  items,
  agentOutputs,
  agentTasks,
  live,
  busy,
  pendingSteers,
}: {
  items: readonly Item[];
  agentOutputs?: Record<string, string>;
  agentTasks?: Record<string, AgentToolTaskView>;
  live?: AgentHistoryPage["live"];
  busy: boolean;
  pendingSteers?: readonly { promptId: string; text: string }[];
}) {
  const rows = useMemo(() => projectRows(items), [items]);
  const delivered = useMemo(
    () => new Set(items.map((item) => item.id)),
    [items],
  );
  const pending = pendingSteers?.filter(
    (steer) => !delivered.has(steer.promptId),
  );
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
      {rows.map((row) => {
        switch (row.kind) {
          case "user":
            return <UserRow key={row.key} row={row} />;
          case "thinking":
            return <ThinkingRow key={row.key} row={row} />;
          case "tools":
            return (
              <ToolGroupRow
                key={row.key}
                row={row}
                agentOutputs={agentOutputs}
                agentTasks={agentTasks}
              />
            );
          case "assistant":
            return <Markdown key={row.key} text={row.text ?? ""} />;
          default:
            return null;
        }
      })}
      {live && (live.thinking || live.text) && (
        <div className="flex flex-col gap-2">
          {live.thinking && (
            <div className="vspi-thinking rounded-md py-1 pl-3 text-ui-caption whitespace-pre-wrap opacity-80">
              {live.thinking}
            </div>
          )}
          {live.text && <Markdown text={live.text} />}
        </div>
      )}
      {pending?.map((steer) => (
        <div
          key={steer.promptId}
          className="vspi-user-surface rounded-xl px-3 py-2 whitespace-pre-wrap opacity-60"
        >
          <div className="mb-1 text-ui-caption text-foreground-subtlest">
            待插入
          </div>
          <div className="text-ui-base/relaxed">{steer.text}</div>
        </div>
      ))}
      {busy && (
        <div className="flex items-center gap-1.5 text-ui-caption text-foreground-subtle">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          <span>正在回复</span>
        </div>
      )}
      {rows.length === 0 && !live && !busy && (
        <div className="py-8 text-center text-ui-base text-foreground-subtle">
          发送消息开始这个会话
        </div>
      )}
    </div>
  );
});

export function ClockTag({ ms }: { ms?: number }) {
  if (ms === undefined) return null;
  return (
    <span className="inline-flex items-center gap-0.5 text-foreground-subtlest">
      <ClockIcon className="size-3" />
      {elapsed(ms)}
    </span>
  );
}
