import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { PlusIcon, XIcon } from "lucide-react";
import { cn } from "./lib/cn";
import { Button } from "./ui";

export function TerminalPanel({ sessionId }: { sessionId: string }) {
  const [ids, setIds] = useState<string[]>([]);
  const [active, setActive] = useState("");
  return (
    <section className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-1 py-1">
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            const id = crypto.randomUUID();
            setIds((old) => [...old, id]);
            setActive(id);
          }}
          disabled={ids.length >= 8}
        >
          <PlusIcon />
          新建终端
        </Button>
        {ids.map((id, i) => (
          <span
            key={id}
            className={cn(
              "flex items-center rounded-md text-ui-caption",
              id === active ? "bg-selected" : "text-foreground-subtle",
            )}
          >
            <button
              aria-pressed={id === active}
              onClick={() => {
                setActive(id);
              }}
              className="px-1.5 py-0.5 outline-none"
            >
              终端 {i + 1}
            </button>
            <button
              aria-label={`关闭终端 ${i + 1}`}
              className="pr-1 text-foreground-subtlest hover:text-foreground"
              onClick={() => {
                setIds((old) => old.filter((item) => item !== id));
                if (active === id)
                  setActive(ids.find((item) => item !== id) ?? "");
              }}
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ))}
      </div>
      {ids.map((id) => (
        <TerminalView
          key={id}
          streamId={id}
          sessionId={sessionId}
          visible={id === active}
        />
      ))}
      {ids.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-4 text-center">
          <p className="text-ui-base text-foreground-subtle">
            在当前工作区打开一个终端。
          </p>
          <p className="text-ui-caption text-foreground-subtlest">
            交互终端在断线时结束，长任务请交由 Agent 或使用 tmux。
          </p>
        </div>
      )}
    </section>
  );
}
function TerminalView({
  sessionId,
  streamId,
  visible,
}: {
  sessionId: string;
  streamId: string;
  visible: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const ptyIdRef = useRef<string | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const resizeNow = () => {
    const terminal = terminalRef.current;
    if (
      !terminal ||
      !container.current?.clientWidth ||
      !container.current.clientHeight
    )
      return;
    fitRef.current?.fit();
    const id = ptyIdRef.current;
    if (id)
      void window.desktop.call("terminalResize", {
        sessionId,
        id,
        cols: terminal.cols,
        rows: terminal.rows,
      }).catch(() => undefined);
  };
  useEffect(() => {
    const dark =
      document.documentElement.classList.contains("theme-zai-dark") ||
      document.documentElement.classList.contains("dark");
    const terminal = new Terminal({
      fontSize: 13,
      lineHeight: 1.2,
      fontFamily:
        getComputedStyle(document.documentElement)
          .getPropertyValue("--font-mono")
          .trim() || "monospace",
      cursorBlink: true,
      theme: dark
        ? { background: "#0e0e10", foreground: "#e3e3e3" }
        : { background: "#fafafa", foreground: "#1a1a1a" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current!);
    fitRef.current = fit;
    terminalRef.current = terminal;
    let disposed = false;
    const call = window.desktop.call;
    const failure = (error: unknown) => {
      if (!disposed)
        terminal.writeln(
          `\r\n${error instanceof Error ? error.message : String(error)}`,
        );
    };
    const observer = new ResizeObserver(resizeNow);
    observer.observe(container.current!);
    resizeNow();
    void document.fonts?.ready.then(resizeNow);
    const unsubscribe = window.desktop.subscribe((event) => {
      if (event.type === "error" && event.streamId === streamId)
        failure(event.message);
      if (event.type !== "terminal" || event.streamId !== streamId) return;
      const frame = event.frame;
      if (frame.type === "terminal_ready") {
        ptyIdRef.current = frame.terminal.id;
        resizeNow();
        terminal.focus();
      }
      if (frame.type === "terminal_output") terminal.write(frame.payload.data);
      if (frame.type === "terminal_exit") {
        ptyIdRef.current = undefined;
        terminal.writeln(
          `\r\n[进程退出：${frame.payload.exit_code ?? "未知"}]`,
        );
      }
    });
    const input = terminal.onData((data) => {
      const id = ptyIdRef.current;
      if (id)
        void call("terminalWrite", { sessionId, id, data }).catch(failure);
    });
    void call("terminalOpen", {
      sessionId,
      streamId,
      cols: terminal.cols,
      rows: terminal.rows,
    }).catch(failure);
    return () => {
      disposed = true;
      unsubscribe();
      observer.disconnect();
      input.dispose();
      void call("terminalClose", { streamId }).catch(() => undefined);
      terminal.dispose();
      fitRef.current = undefined;
      terminalRef.current = undefined;
      ptyIdRef.current = undefined;
    };
  }, [sessionId, streamId]);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(resizeNow);
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  return (
    <div
      ref={container}
      className="terminal-xterm-shell min-h-0 flex-1 p-1"
      hidden={!visible}
    />
  );
}
