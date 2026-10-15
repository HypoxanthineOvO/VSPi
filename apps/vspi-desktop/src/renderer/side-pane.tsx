import { useCallback, useRef, useState } from "react";
import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { cn } from "./lib/cn";
import { Button, Tabs, TabsList, TabsTrigger } from "./ui";
import { Files } from "./Files";
import { TerminalPanel } from "./TerminalPanel";

export function SidePane({
  sessionId,
  host,
  open,
  onToggle,
}: {
  sessionId: string;
  host?: string;
  open: boolean;
  onToggle: () => void;
}) {
  const [tab, setTab] = useState("files");
  const [width, setWidth] = useState(320);
  const drag = useRef<{ start: number; width: number } | undefined>(
    undefined,
  );
  const onDragStart = useCallback(
    (event: React.PointerEvent) => {
      drag.current = { start: event.clientX, width };
      const move = (next: PointerEvent) => {
        if (!drag.current) return;
        const delta = drag.current.start - next.clientX;
        setWidth(
          Math.min(560, Math.max(240, drag.current.width + delta)),
        );
      };
      const up = () => {
        drag.current = undefined;
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      event.preventDefault();
    },
    [width],
  );
  return (
    <>
      {!open && (
        <div className="flex w-10 shrink-0 flex-col items-center border-l border-border bg-panel py-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="展开侧栏"
            onClick={onToggle}
          >
            <PanelRightOpenIcon />
          </Button>
        </div>
      )}
      <div className="flex shrink-0" style={{ width }} hidden={!open}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
        onPointerDown={onDragStart}
        className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-selected active:bg-selected"
      />
      <aside className="flex min-w-0 flex-1 flex-col border-l border-border bg-panel">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <Tabs
            value={tab}
            onValueChange={setTab}
            className="min-w-0 flex-1 flex-row"
          >
            <TabsList>
              <TabsTrigger value="files">文件</TabsTrigger>
              <TabsTrigger value="changes">变更</TabsTrigger>
              <TabsTrigger value="terminal">终端</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="收起侧栏"
            onClick={onToggle}
          >
            <PanelRightCloseIcon />
          </Button>
        </div>
        {sessionId ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div
              className="min-h-0 flex-1 overflow-y-auto p-2"
              hidden={tab !== "files"}
            >
              <Files key={`${sessionId}:files`} sessionId={sessionId} />
            </div>
            <div
              className="min-h-0 flex-1 overflow-y-auto p-2"
              hidden={tab !== "changes"}
            >
              <Files
                key={`${sessionId}:changes`}
                sessionId={sessionId}
                changes
              />
            </div>
            <div
              className={cn("min-h-0 flex-1")}
              hidden={tab !== "terminal"}
            >
              <TerminalPanel key={sessionId} sessionId={sessionId} />
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-4 text-center text-ui-base text-foreground-subtle">
            打开会话后查看工作区{host ? `（${host}）` : ""}
          </div>
        )}
      </aside>
    </div>
    </>
  );
}
