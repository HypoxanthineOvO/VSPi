import { useMemo, useState } from "react";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  FolderIcon,
  MoonIcon,
  PlusIcon,
  ServerIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react";
import type {
  ConnectionInfo,
  DesktopMethods,
  HostListView,
} from "../shared.js";
import { cn } from "./lib/cn";
import { formatSessionDate } from "./lib/dates";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from "./ui";

type Sessions = DesktopMethods["sessions"]["output"]["items"];
type Workspaces = DesktopMethods["workspaces"]["output"];

function workspaceName(root: string): string {
  const name = root.replace(/\/+$/, "").split("/").at(-1);
  return name ?? root;
}

export function Sidebar({
  connection,
  hosts,
  status,
  workspaces,
  sessions,
  sessionId,
  theme,
  onToggleTheme,
  onOpenSettings,
  onOpenSession,
  onNewSession,
  onAddWorkspace,
  onSwitchHost,
  onAddHost,
  hasMore,
  onLoadMore,
}: {
  connection?: ConnectionInfo;
  hosts?: HostListView;
  status: string;
  workspaces: Workspaces;
  sessions: Sessions;
  sessionId: string;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onOpenSession: (id: string) => void;
  onNewSession: (workspaceRoot: string) => void;
  onAddWorkspace: () => void;
  onSwitchHost: (id: string) => void;
  onAddHost: () => void;
  hasMore?: boolean;
  onLoadMore: () => void;
}) {
  const [filter, setFilter] = useState("");
  const grouped = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const match = (title: string) =>
      !query || title.toLowerCase().includes(query);
    return workspaces.map((workspace) => ({
      workspace,
      sessions: sessions.filter(
        (item) =>
          item.workspaceId === workspace.id &&
          match(item.title ?? item.lastPrompt ?? ""),
      ),
    }));
  }, [workspaces, sessions, filter]);
  const hostLabel = connection?.label ?? "本机";
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-11 items-center gap-2 px-3">
        <span className="flex size-6 items-center justify-center rounded-md bg-primary text-ui-caption font-bold text-primary-foreground">
          V
        </span>
        <span className="text-ui-lg font-semibold">VSPi</span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="切换主题"
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </Button>
      </div>
      <div className="px-2 pb-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-1.5 rounded-md border border-border bg-input px-2 py-1 text-ui-base text-foreground outline-none hover:border-border-hover">
              <ServerIcon className="size-3.5 shrink-0 text-foreground-subtle" />
              <span className="min-w-0 flex-1 truncate text-left">
                {hostLabel}
              </span>
              <ChevronsUpDownIcon className="size-3.5 shrink-0 text-foreground-subtle" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>主机</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => onSwitchHost("local")}>
              <ServerIcon className="text-foreground-subtle" />
              <span className="flex-1">本机</span>
              {hosts?.active === "local" && (
                <CheckIcon className="text-success" />
              )}
            </DropdownMenuItem>
            {hosts?.remotes.map((remote) => (
              <DropdownMenuItem
                key={remote.id}
                onSelect={() => onSwitchHost(remote.id)}
              >
                <ServerIcon className="text-foreground-subtle" />
                <span className="flex-1 truncate">{remote.label}</span>
                {hosts.active === remote.id && (
                  <CheckIcon className="text-success" />
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onAddHost}>
              <PlusIcon />
              添加远程主机…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="px-2 pb-2">
        <Input
          aria-label="筛选会话"
          placeholder="搜索会话…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="flex items-center justify-between px-1 py-1">
          <span className="text-ui-caption font-medium text-foreground-subtle">
            工作区
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="打开文件夹"
            onClick={onAddWorkspace}
          >
            <PlusIcon />
          </Button>
        </div>
        {grouped.map(({ workspace, sessions: items }) => (
          <section key={workspace.id} className="mb-1">
            <div className="flex items-center gap-1 rounded-md px-1 py-1">
              <FolderIcon className="size-3.5 shrink-0 text-foreground-subtle" />
              <span
                className="min-w-0 flex-1 truncate text-ui-base font-medium"
                title={workspace.root}
              >
                {workspace.name ?? workspaceName(workspace.root)}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`在 ${workspaceName(workspace.root)} 新建会话`}
                onClick={() => onNewSession(workspace.root)}
              >
                <PlusIcon />
              </Button>
            </div>
            {items.map((item) => (
              <button
                key={item.id}
                onClick={() => onOpenSession(item.id)}
                className={cn(
                  "flex w-full flex-col rounded-md px-2 py-1 text-left outline-none hover:bg-hover",
                  sessionId === item.id && "bg-selected",
                )}
              >
                <span className="truncate text-ui-base text-foreground">
                  {item.title ?? item.lastPrompt ?? "新会话"}
                </span>
                <span className="text-ui-caption text-foreground-subtlest">
                  {formatSessionDate(item.updatedAt)}
                </span>
              </button>
            ))}
          </section>
        ))}
        {grouped.length === 0 && (
          <p className="px-1 py-2 text-ui-caption text-foreground-subtle">
            连接后显示工作区
          </p>
        )}
        {hasMore && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 w-full"
            onClick={onLoadMore}
          >
            加载更多会话
          </Button>
        )}
      </div>
      <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="justify-start gap-1.5 px-1.5"
          onClick={onOpenSettings}
        >
          <SettingsIcon />
          设置
        </Button>
        <span className="flex-1" />
        <span
          className={cn(
            "flex items-center gap-1 text-ui-caption text-foreground-subtle",
            !connection && "text-foreground-subtlest",
          )}
          title={connection ? `${connection.label} · ${connection.version}` : status}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              connection ? "bg-success" : "bg-foreground-subtlest",
            )}
          />
          {connection ? "已连接" : "未连接"}
        </span>
      </div>
    </aside>
  );
}
