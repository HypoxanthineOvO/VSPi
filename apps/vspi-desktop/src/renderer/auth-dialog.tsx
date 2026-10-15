import { useState } from "react";
import type { DesktopEvent } from "../shared.js";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
} from "./ui";

export function AuthDialog({
  request,
  done,
}: {
  request: Extract<DesktopEvent, { type: "auth" }>;
  done: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const send = (value: string | null) => {
    void window.desktop
      .call("authAnswer", { id: request.id, answer: value })
      .finally(done);
    setAnswer("");
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) send(null);
      }}
    >
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogTitle>
          {request.confirm ? "确认 SSH 主机身份" : "SSH 认证"}
        </DialogTitle>
        <pre className="max-h-40 overflow-auto rounded-md border border-border bg-terminal-bg p-2 font-mono text-ui-caption text-terminal-fg whitespace-pre-wrap">
          {request.prompt}
        </pre>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            send(request.confirm ? "yes" : answer);
          }}
        >
          {!request.confirm && (
            <Input
              autoFocus
              type="password"
              autoComplete="off"
              aria-label="密码或密钥口令"
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
            />
          )}
          <div className="flex justify-end gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => send(null)}
            >
              取消
            </Button>
            <Button type="submit" size="sm">
              {request.confirm ? "信任此指纹并连接" : "继续"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
