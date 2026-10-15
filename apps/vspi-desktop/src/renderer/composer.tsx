import { useEffect, useRef, useState } from "react";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  SquareIcon,
} from "lucide-react";
import type { DesktopMethods } from "../shared.js";
import { cn } from "./lib/cn";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Input,
} from "./ui";

type Models = DesktopMethods["models"]["output"];
type PermissionMode = "auto" | "manual" | "yolo";

const permissionLabels: Record<PermissionMode, string> = {
  manual: "手动审批",
  auto: "自动判断",
  yolo: "允许全部",
};

export function Composer({
  disabled,
  busy,
  draft,
  onDraft,
  onSubmit,
  onStop,
  models,
  model,
  effort,
  permission,
  onModel,
  onPermission,
  pendingRetry,
}: {
  disabled: boolean;
  busy: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onSubmit: (mode: "queue" | "steer") => void;
  onStop: () => void;
  models: Models;
  model?: string;
  effort?: string;
  permission?: PermissionMode;
  onModel: (model: string, effort?: string) => void;
  onPermission: (mode: PermissionMode) => void;
  pendingRetry?: { text: string };
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [modelFilter, setModelFilter] = useState("");
  useEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [draft]);
  const current = models.find((item) => item.model === model);
  const efforts = current?.support_efforts ?? [];
  const modelLabel = current?.display_name ?? current?.model ?? "选择模型";
  const filtered = models.filter((item) => {
    const query = modelFilter.trim().toLowerCase();
    if (!query) return true;
    return `${item.display_name ?? ""} ${item.model} ${item.provider}`
      .toLowerCase()
      .includes(query);
  });
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-3">
      {pendingRetry && (
        <div className="mb-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-ui-caption text-foreground">
          消息尚未确认送达：{pendingRetry.text.slice(0, 80)}，点击发送重试。
        </div>
      )}
      <div className="rounded-2xl border border-input-border bg-input transition-colors focus-within:border-input-border-focused">
        <textarea
          ref={area}
          aria-label="消息"
          rows={1}
          disabled={disabled}
          placeholder={
            disabled ? "连接后可发送消息" : "描述你想完成的工作…"
          }
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              onSubmit(busy ? "steer" : "queue");
            }
          }}
          className="max-h-50 w-full resize-none rounded-2xl bg-transparent px-3 pt-2.5 pb-1 text-ui-base/relaxed text-foreground outline-none placeholder:text-foreground-subtlest disabled:opacity-50"
        />
        <div className="flex items-center gap-1 px-2 pb-1.5">
          <DropdownMenu onOpenChange={(open) => !open && setModelFilter("")}>
            <DropdownMenuTrigger asChild>
              <button
                disabled={disabled}
                className="flex h-6 max-w-44 items-center gap-1 rounded-md px-1.5 text-ui-base text-foreground-subtle outline-none hover:bg-hover hover:text-foreground disabled:opacity-50"
              >
                <span className="truncate">{modelLabel}</span>
                <ChevronDownIcon className="size-3.5 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <div className="p-1" onKeyDown={(event) => event.stopPropagation()}>
                <Input
                  aria-label="筛选模型"
                  placeholder="筛选模型…"
                  value={modelFilter}
                  onChange={(event) => setModelFilter(event.target.value)}
                />
              </div>
              {filtered.map((item) => (
                <DropdownMenuItem
                  key={`${item.provider}/${item.model}`}
                  onSelect={() => onModel(item.model)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {item.display_name ?? item.model}
                  </span>
                  <span className="shrink-0 text-ui-caption text-foreground-subtlest">
                    {item.provider}
                  </span>
                  {item.model === model && (
                    <CheckIcon className="text-success" />
                  )}
                </DropdownMenuItem>
              ))}
              {filtered.length === 0 && (
                <DropdownMenuLabel>没有匹配的模型</DropdownMenuLabel>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {efforts.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  disabled={disabled}
                  className="flex h-6 items-center gap-1 rounded-md px-1.5 text-ui-base text-foreground-subtle outline-none hover:bg-hover hover:text-foreground disabled:opacity-50"
                >
                  <span>Effort {effort ?? "默认"}</span>
                  <ChevronDownIcon className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {efforts.map((value) => (
                  <DropdownMenuItem
                    key={value}
                    onSelect={() => model && onModel(model, value)}
                  >
                    <span className="flex-1">{value}</span>
                    {value === effort && <CheckIcon className="text-success" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                disabled={disabled}
                className="flex h-6 items-center gap-1 rounded-md px-1.5 text-ui-base text-foreground-subtle outline-none hover:bg-hover hover:text-foreground disabled:opacity-50"
              >
                <span>{permissionLabels[permission ?? "manual"]}</span>
                <ChevronDownIcon className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {(Object.keys(permissionLabels) as PermissionMode[]).map(
                (value) => (
                  <DropdownMenuItem
                    key={value}
                    onSelect={() => onPermission(value)}
                  >
                    <span className="flex-1">{permissionLabels[value]}</span>
                    {value === permission && (
                      <CheckIcon className="text-success" />
                    )}
                  </DropdownMenuItem>
                ),
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="flex-1" />
          {busy && (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={onStop}
              >
                <SquareIcon />
                停止
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || !draft.trim()}
                onClick={() => onSubmit("steer")}
              >
                插入
              </Button>
            </>
          )}
          <Button
            variant="default"
            size="icon-sm"
            className={cn("rounded-full", !busy && "size-7")}
            aria-label={busy ? "插入消息" : "发送"}
            disabled={disabled || !draft.trim()}
            onClick={() => onSubmit(busy ? "steer" : "queue")}
          >
            <ArrowUpIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}
