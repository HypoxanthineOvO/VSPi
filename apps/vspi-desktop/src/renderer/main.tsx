import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LoaderCircleIcon, XIcon } from "lucide-react";
import type {
  AgentHistoryPage,
  ConnectionInfo,
  DesktopEvent,
  DesktopMethods,
  HostListView,
  SessionView,
} from "../shared.js";
import { cn } from "./lib/cn";
import { Button } from "./ui";
import { Sidebar } from "./sidebar";
import { Transcript } from "./transcript";
import { Composer } from "./composer";
import { ApprovalCard, QuestionCard } from "./interactions";
import { EmptyState } from "./empty-state";
import { SidePane } from "./side-pane";
import { SettingsPage } from "./settings-page";
import { FolderDialog, RemoteHostDialog } from "./host-dialog";
import { AuthDialog } from "./auth-dialog";
import "./style.css";

type Sessions = DesktopMethods["sessions"]["output"]["items"];
type Workspaces = DesktopMethods["workspaces"]["output"];
const call = window.desktop.call;

function stored<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function App() {
  const [connection, setConnection] = useState<ConnectionInfo>();
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState("正在启动…");
  const [error, setError] = useState("");
  const [hosts, setHosts] = useState<HostListView>();
  const [settings, setSettings] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspaces>([]);
  const [sessions, setSessions] = useState<Sessions>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [sessionId, setSessionId] = useState("");
  const active = useRef("");
  const [view, setView] = useState<SessionView>();
  const [older, setOlder] = useState<AgentHistoryPage["items"]>([]);
  const [before, setBefore] = useState<number>();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [paneOpen, setPaneOpen] = useState(true);
  const [folderDialog, setFolderDialog] = useState(false);
  const [hostDialog, setHostDialog] = useState(false);
  const [auth, setAuth] = useState<Extract<DesktopEvent, { type: "auth" }>>();
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    stored("vspi-theme", "dark"),
  );
  const [models, setModels] = useState<DesktopMethods["models"]["output"]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const timeline = useRef<HTMLDivElement>(null);
  const draftKey = `vspi-draft:${connection?.runtimeId ?? "new"}:${sessionId}`;
  const [uncertain, setUncertain] = useState<{
    promptId: string;
    text: string;
    mode: "queue" | "steer";
  }>();
  const [pendingSteers, setPendingSteers] = useState<
    { promptId: string; text: string }[]
  >([]);
  const fail = (error: unknown) => {
    setError(error instanceof Error ? error.message : String(error));
  };

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.classList.toggle("theme-zai-dark", theme === "dark");
    root.classList.toggle("theme-zai-light", theme === "light");
    localStorage.setItem("vspi-theme", JSON.stringify(theme));
  }, [theme]);

  useEffect(
    () =>
      window.desktop.subscribe((event) => {
        if (event.type === "connection") {
          setStatus(event.message);
          if (event.disconnected) {
            setConnection(undefined);
            setConnecting(false);
            setPendingSteers([]);
          }
        }
        if (event.type === "auth") setAuth(event);
        if (event.type === "session" && event.sessionId === active.current)
          setView(event.view);
        if (event.type === "error") setError(event.message);
      }),
    [],
  );

  useEffect(() => {
    if (autoScroll && timeline.current)
      timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [view, autoScroll]);

  useEffect(() => {
    if (pendingSteers.length === 0 || !view) return;
    const delivered = new Set(
      [...older, ...view.history.items].map((item) => item.id),
    );
    setPendingSteers((old) =>
      old.every((steer) => delivered.has(steer.promptId))
        ? []
        : old.filter((steer) => !delivered.has(steer.promptId)),
    );
  }, [view, older, pendingSteers.length]);

  async function refresh() {
    const [spaces, result] = await Promise.all([
      call("workspaces", undefined),
      call("sessions", {}),
    ]);
    setWorkspaces(spaces);
    setSessions(result.items);
    setNextCursor(result.nextCursor);
  }

  async function connect(hostId: string) {
    setConnecting(true);
    setError("");
    setStatus("正在连接…");
    try {
      const info = await call("connectHost", { id: hostId });
      setConnection(info);
      setView(undefined);
      setSessionId("");
      active.current = "";
      setOlder([]);
      await refresh();
      setModels(await call("models", undefined));
      setStatus("已连接");
    } catch (error) {
      fail(error);
      setStatus("连接失败");
    } finally {
      setConnecting(false);
    }
  }

  useEffect(() => {
    void call("listHosts", undefined)
      .then(setHosts)
      .catch(() => undefined);
    void connect("local");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function open(id: string) {
    active.current = id;
    setSessionId(id);
    setView(undefined);
    setOlder([]);
    setError("");
    setAutoScroll(true);
    setPendingSteers([]);
    const key = `vspi-draft:${connection!.runtimeId}:${id}`;
    setDraft(stored(key, ""));
    setUncertain(stored<typeof uncertain>(`${key}:pending`, undefined));
    try {
      const next = await call("open", { sessionId: id });
      if (active.current === id) {
        setView(next);
        setBefore(next.history.before);
      }
    } catch (error) {
      if (active.current === id) fail(error);
    }
  }

  async function createAndOpen(path: string) {
    const id = await call("create", { path });
    await refresh();
    await open(id);
  }

  async function submit(mode: "queue" | "steer") {
    if (sending || (!draft.trim() && !uncertain)) return;
    setSending(true);
    setError("");
    try {
      let target = sessionId;
      if (!target) {
        const root = workspaces[0]?.root;
        if (!root) {
          setFolderDialog(true);
          return;
        }
        target = await call("create", { path: root });
        await refresh();
        await open(target);
      }
      const submission = uncertain ?? {
        promptId: crypto.randomUUID(),
        text: draft,
        mode,
      };
      const key = `vspi-draft:${connection!.runtimeId}:${target}`;
      localStorage.setItem(`${key}:pending`, JSON.stringify(submission));
      setUncertain(submission);
      const receipt = await call("submit", {
        sessionId: target,
        ...submission,
      });
      if (receipt.state !== "accepted")
        throw new Error("运行时在接收期间中断；请核对历史后再提交新的消息。");
      if (submission.mode === "steer")
        setPendingSteers((old) => [
          ...old.filter(
            (steer) => steer.promptId !== submission.promptId,
          ),
          { promptId: submission.promptId, text: submission.text },
        ]);
      localStorage.removeItem(`${key}:pending`);
      localStorage.removeItem(key);
      if (active.current === target) {
        setDraft("");
        setUncertain(undefined);
        setAutoScroll(true);
      }
      await refresh();
    } catch (error) {
      fail(error);
    } finally {
      setSending(false);
    }
  }

  const current = sessions.find((item) => item.id === sessionId);
  const busy = !!view?.history.activity.turn;
  const composerDisabled = !connection || (!!sessionId && !view);
  const bannerVisible = connecting || !!error || (!connection && status !== "正在启动…");

  return (
    <div className="flex h-dvh w-full bg-background text-foreground">
      <Sidebar
        connection={connection}
        hosts={hosts}
        status={status}
        workspaces={workspaces}
        sessions={sessions}
        sessionId={sessionId}
        theme={theme}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        onOpenSettings={() => setSettings(true)}
        onOpenSession={(id) => void open(id)}
        onNewSession={(root) => void createAndOpen(root).catch(fail)}
        onAddWorkspace={() => setFolderDialog(true)}
        onSwitchHost={(id) => void connect(id)}
        onAddHost={() => setHostDialog(true)}
        hasMore={!!nextCursor}
        onLoadMore={() =>
          void call("sessions", { before: nextCursor })
            .then((result) => {
              setSessions((old) => [...old, ...result.items]);
              setNextCursor(result.nextCursor);
            })
            .catch(fail)
        }
      />
      <main className="flex min-w-0 flex-1 flex-col">
        {bannerVisible && (
          <div
            role="status"
            className={cn(
              "flex items-center gap-2 border-b px-4 py-1.5 text-ui-caption",
              error
                ? "border-destructive/40 bg-destructive/10 text-foreground"
                : "border-border bg-surface text-foreground-subtle",
            )}
          >
            {connecting && (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {error || status}
            </span>
            {error && (
              <button
                aria-label="关闭提示"
                className="text-foreground-subtle hover:text-foreground"
                onClick={() => setError("")}
              >
                <XIcon className="size-3.5" />
              </button>
            )}
            {!connection && !connecting && (
              <Button
                variant="outline"
                size="xs"
                onClick={() => void connect(hosts?.active ?? "local")}
              >
                重试连接
              </Button>
            )}
          </div>
        )}
        <div
          ref={timeline}
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={() => {
            const node = timeline.current!;
            setAutoScroll(
              node.scrollHeight - node.scrollTop - node.clientHeight < 90,
            );
          }}
        >
          {sessionId ? (
            <>
              <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 pt-3">
                <h1 className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
                  {current?.title ?? "新会话"}
                </h1>
                {before !== undefined && (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      void call("history", { sessionId, before })
                        .then((page) => {
                          setOlder((old) => [...page.items, ...old]);
                          setBefore(page.before);
                        })
                        .catch(fail)
                    }
                  >
                    加载更早历史
                  </Button>
                )}
              </div>
              {view ? (
                <Transcript
                  items={[...older, ...view.history.items]}
                  agentOutputs={view.agentOutputs}
                  agentTasks={view.agentTasks}
                  live={view.history.live}
                  busy={busy}
                  pendingSteers={pendingSteers}
                />
              ) : (
                <div className="mx-auto w-full max-w-3xl px-4 py-8 text-center text-ui-base text-foreground-subtle">
                  正在加载会话…
                </div>
              )}
              {!busy &&
                view?.history.activity.lastTurn?.reason === "failed" && (
                  <p
                    role="alert"
                    className="mx-auto w-full max-w-3xl px-4 pb-2 text-ui-caption text-destructive"
                  >
                    任务执行失败。请检查当前模型与设置。
                  </p>
                )}
            </>
          ) : (
            <EmptyState
              workspaces={workspaces}
              onPick={(root) => void createAndOpen(root).catch(fail)}
              onBrowse={() => setFolderDialog(true)}
            />
          )}
        </div>
        {!autoScroll && (
          <button
            className="absolute right-4 bottom-28 rounded-full border border-border bg-popover px-2 py-1 text-ui-caption text-foreground-subtle shadow-md"
            onClick={() => setAutoScroll(true)}
          >
            ↓ 回到最新
          </button>
        )}
        {sessionId && view && (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-2">
            {view.approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                onDecide={(id, decision) =>
                  void call("approve", { sessionId, id, decision }).catch(fail)
                }
              />
            ))}
            {view.questions.map((question) => (
              <QuestionCard
                key={question.id}
                question={question}
                onAnswer={(id, answers) =>
                  void call("answer", { sessionId, id, answers }).catch(fail)
                }
              />
            ))}
          </div>
        )}
        <Composer
          disabled={composerDisabled}
          busy={busy}
          draft={draft}
          onDraft={(value) => {
            setDraft(value);
            localStorage.setItem(draftKey, JSON.stringify(value));
          }}
          onSubmit={(mode) => void submit(mode)}
          onStop={() => void call("stop", { sessionId }).catch(fail)}
          models={models}
          model={view?.history.model}
          effort={view?.history.effort}
          permission={view?.permission}
          onModel={(model, thinking) =>
            sessionId &&
            void call("model", { sessionId, model, thinking }).catch(fail)
          }
          onPermission={(mode) =>
            sessionId &&
            void call("permission", { sessionId, mode }).catch(fail)
          }
          pendingRetry={uncertain}
        />
      </main>
      <SidePane
        sessionId={sessionId}
        host={connection?.label}
        open={paneOpen}
        onToggle={() => setPaneOpen(!paneOpen)}
      />
      {settings && (
        <SettingsPage
          connection={connection}
          theme={theme}
          onTheme={setTheme}
          hosts={hosts}
          onHostsChanged={setHosts}
          onClose={() => {
            setSettings(false);
            if (connection)
              void call("models", undefined).then(setModels).catch(() => {});
          }}
        />
      )}
      {folderDialog && (
        <FolderDialog
          onPick={(path) => {
            setFolderDialog(false);
            void createAndOpen(path).catch(fail);
          }}
          onClose={() => setFolderDialog(false)}
        />
      )}
      {hostDialog && (
        <RemoteHostDialog
          onSaved={(next) => {
            setHosts(next);
            setHostDialog(false);
          }}
          onClose={() => setHostDialog(false)}
        />
      )}
      {auth && <AuthDialog request={auth} done={() => setAuth(undefined)} />}
    </div>
  );
}
createRoot(document.querySelector("#root")!).render(<App />);
