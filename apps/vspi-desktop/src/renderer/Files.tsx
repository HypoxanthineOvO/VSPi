import { useEffect, useState } from "react";
import {
  ArrowLeftIcon,
  FileIcon,
  FolderIcon,
  RefreshCwIcon,
} from "lucide-react";
import type { FileEntry, FilePreview } from "../shared.js";
import { cn } from "./lib/cn";
import { Button } from "./ui";

export function Files({
  sessionId,
  changes = false,
}: {
  sessionId: string;
  changes?: boolean;
}) {
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [preview, setPreview] = useState<FilePreview>();
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    setPreview(undefined);
    void (async () => {
      if (changes) {
        const result = await window.desktop.call("changes", { sessionId });
        if (active) {
          setEntries(
            Object.entries(result.entries)
              .filter(
                ([, status]) => status !== "clean" && status !== "ignored",
              )
              .map(([path, status]) => ({
                path,
                name: `${path} · ${status}`,
                kind: "file",
              })),
          );
          setTruncated(false);
        }
      } else {
        const result = await window.desktop.call("files", { sessionId, path });
        if (active) {
          setEntries(result.items);
          setTruncated(result.truncated);
        }
      }
    })().catch((error) => {
      if (active) setError(error.message);
    });
    return () => {
      active = false;
    };
  }, [sessionId, path, changes, revision]);
  async function open(entry: FileEntry) {
    if (entry.kind === "directory") {
      setPath(entry.path);
      return;
    }
    setError("");
    try {
      if (changes) {
        const result = await window.desktop.call("diff", {
          sessionId,
          path: entry.path,
        });
        setPreview({
          path: entry.path,
          content: result.diff,
          encoding: "utf-8",
          mime: "text/plain",
          truncated: result.truncated,
        });
      } else
        setPreview(
          await window.desktop.call("preview", { sessionId, path: entry.path }),
        );
    } catch (error) {
      setError(error instanceof Error ? error.message : "读取失败");
    }
  }
  return (
    <section className="flex h-full flex-col gap-1">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="返回"
          onClick={() => {
            if (preview) setPreview(undefined);
            else setPath(path.split("/").slice(0, -1).join("/") || ".");
          }}
        >
          <ArrowLeftIcon />
        </Button>
        <span
          className="min-w-0 flex-1 truncate font-mono text-ui-caption text-foreground-subtle"
          title={preview?.path ?? path}
        >
          {preview?.path ?? path}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="刷新"
          onClick={() => {
            setRevision((value) => value + 1);
          }}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-ui-caption text-destructive">
          {error}
        </p>
      )}
      {preview ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {preview.truncated && (
            <p className="text-ui-caption text-foreground-subtle">
              预览已截断，文件超过显示限额。
            </p>
          )}
          {preview.encoding === "base64" ? (
            /^image\/(png|jpeg|gif|webp)$/.test(preview.mime) &&
            !preview.truncated ? (
              <img
                className="max-w-full rounded-md border border-border"
                src={`data:${preview.mime};base64,${preview.content}`}
                alt={preview.path}
              />
            ) : (
              <p className="text-ui-caption text-foreground-subtle">
                此文件不支持安全图片预览。
              </p>
            )
          ) : (
            <pre className="font-mono text-ui-caption leading-relaxed whitespace-pre-wrap text-foreground">
              {preview.content.split("\n").map((line, index) => (
                <span
                  key={index}
                  className={cn(
                    "block",
                    line.startsWith("+") && !line.startsWith("+++") && "vspi-diff-add",
                    line.startsWith("-") && !line.startsWith("---") && "vspi-diff-del",
                    line.startsWith("@@") && "vspi-diff-hunk",
                  )}
                >
                  {line || " "}
                </span>
              ))}
            </pre>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {entries.map((entry) => (
            <button
              key={entry.path}
              onClick={() => void open(entry)}
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-ui-base text-foreground outline-none hover:bg-hover"
            >
              {entry.kind === "directory" ? (
                <FolderIcon className="size-3.5 shrink-0 text-foreground-subtle" />
              ) : (
                <FileIcon className="size-3.5 shrink-0 text-foreground-subtle" />
              )}
              <span className="truncate">{entry.name}</span>
            </button>
          ))}
          {entries.length === 0 && (
            <div className="p-4 text-center text-ui-caption text-foreground-subtle">
              {changes ? "没有未提交的变更" : "目录为空"}
            </div>
          )}
          {truncated && (
            <p className="px-1.5 py-1 text-ui-caption text-foreground-subtle">
              仅显示前 200 项，请进入子目录继续浏览。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
