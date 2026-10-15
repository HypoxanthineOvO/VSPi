import { useEffect, useState } from "react";
import type { HostListView, RemoteHostView } from "../shared.js";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
} from "./ui";

export function RemoteHostDialog({
  remote,
  onSaved,
  onClose,
}: {
  remote?: RemoteHostView;
  onSaved: (hosts: HostListView) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(remote?.label ?? "");
  const [host, setHost] = useState(remote?.host ?? "");
  const [port, setPort] = useState(remote?.port?.toString() ?? "");
  const [executable, setExecutable] = useState(remote?.executable ?? "");
  const [homeDir, setHomeDir] = useState(remote?.homeDir ?? "");
  const [aliases, setAliases] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void window.desktop
      .call("aliases", undefined)
      .then(setAliases)
      .catch(() => undefined);
  }, []);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogTitle>
          {remote ? "编辑远程主机" : "添加远程主机"}
        </DialogTitle>
        <DialogDescription>
          通过 SSH 在远端启动 VSPi 运行时；凭据由本机 SSH 代理或密码输入提供。
        </DialogDescription>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            void window.desktop
              .call("upsertRemote", {
                id: remote?.id,
                label: label || host,
                host,
                port: port ? Number(port) : undefined,
                executable: executable || undefined,
                homeDir: homeDir || undefined,
              })
              .then(onSaved)
              .catch((error) => {
                setError(
                  error instanceof Error ? error.message : "保存失败",
                );
              })
              .finally(() => setBusy(false));
          }}
        >
          <label className="block">
            <span className="mb-1 block text-ui-base">名称</span>
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="例如：开发机"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-ui-base">
              SSH 别名或 user@host
            </span>
            <Input
              autoFocus
              required
              value={host}
              onChange={(event) => setHost(event.target.value)}
              list="ssh-aliases"
              placeholder="devbox"
            />
            <datalist id="ssh-aliases">
              {aliases.map((alias) => (
                <option key={alias}>{alias}</option>
              ))}
            </datalist>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-ui-base">SSH 端口</span>
              <Input
                inputMode="numeric"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                placeholder="沿用 SSH 配置"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-ui-base">远端可执行文件</span>
              <Input
                value={executable}
                onChange={(event) => setExecutable(event.target.value)}
                placeholder="vspi"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-ui-base">远端数据目录</span>
            <Input
              value={homeDir}
              onChange={(event) => setHomeDir(event.target.value)}
              placeholder="沿用远端默认值"
            />
          </label>
          {error && (
            <p role="alert" className="text-ui-caption text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function FolderDialog({
  onPick,
  onClose,
}: {
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState("~");
  const [folders, setFolders] =
    useState<Awaited<ReturnType<typeof browse>>>();
  const [error, setError] = useState("");
  async function browse(value: string) {
    return window.desktop.call("browse", { path: value });
  }
  const go = async (value = path) => {
    try {
      const result = await browse(value);
      setFolders(result);
      setPath(result.path);
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "读取目录失败");
    }
  };
  useEffect(() => {
    void go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogTitle>打开文件夹</DialogTitle>
        <DialogDescription>选择远端工作区目录。</DialogDescription>
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void go();
          }}
        >
          <Input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            aria-label="路径"
          />
          <Button type="submit" variant="outline" size="sm">
            浏览
          </Button>
        </form>
        {error && (
          <p role="alert" className="text-ui-caption text-destructive">
            {error}
          </p>
        )}
        <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {folders?.parent && (
            <button
              className="rounded-md px-2 py-1 text-left text-ui-base outline-none hover:bg-hover"
              onClick={() => void go(folders.parent!)}
            >
              ↑ 上一级
            </button>
          )}
          {folders?.entries.map((folder) => (
            <button
              key={folder.path}
              className="rounded-md px-2 py-1 text-left text-ui-base outline-none hover:bg-hover"
              onClick={() => void go(folder.path)}
            >
              ▸ {folder.name}
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={!folders}
            onClick={() => folders && onPick(folders.path)}
          >
            在此目录新建会话
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
