import { useEffect, useState } from "react";
import {
  InfoIcon,
  MonitorIcon,
  MoonIcon,
  PlugIcon,
  ServerIcon,
  SunIcon,
  XIcon,
} from "lucide-react";
import type {
  ConnectionInfo,
  DesktopSettingsSnapshot,
  HostListView,
  ProviderSettingsEdit,
  RemoteHostView,
} from "../shared.js";
import { cn } from "./lib/cn";
import {
  Button,
  Input,
  Select,
} from "./ui";
import { RemoteHostDialog } from "./host-dialog";

type Section = "general" | "providers" | "connection" | "about";

const sections: { id: Section; label: string; icon: typeof SunIcon }[] = [
  { id: "general", label: "通用", icon: MonitorIcon },
  { id: "providers", label: "模型与 Provider", icon: PlugIcon },
  { id: "connection", label: "连接", icon: ServerIcon },
  { id: "about", label: "关于", icon: InfoIcon },
];

export function SettingsPage({
  connection,
  theme,
  onTheme,
  hosts,
  onHostsChanged,
  onClose,
}: {
  connection?: ConnectionInfo;
  theme: "dark" | "light";
  onTheme: (theme: "dark" | "light") => void;
  hosts?: HostListView;
  onHostsChanged: (hosts: HostListView) => void;
  onClose: () => void;
}) {
  const [section, setSection] = useState<Section>("general");
  return (
    <div className="fixed inset-0 z-40 flex bg-background">
      <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-border bg-sidebar p-2">
        <div className="flex items-center justify-between px-1.5 py-2">
          <span className="text-ui-lg font-semibold">设置</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭设置"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
        {sections.map((item) => (
          <button
            key={item.id}
            onClick={() => setSection(item.id)}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-base outline-none hover:bg-hover",
              section === item.id
                ? "bg-selected text-foreground"
                : "text-foreground-subtle",
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-6">
          {section === "general" && (
            <GeneralSection theme={theme} onTheme={onTheme} />
          )}
          {section === "providers" && <ProvidersSection />}
          {section === "connection" && (
            <ConnectionSection
              hosts={hosts}
              onHostsChanged={onHostsChanged}
            />
          )}
          {section === "about" && <AboutSection connection={connection} />}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="mb-4 text-ui-xl font-semibold text-foreground">
      {children}
    </h2>
  );
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-ui-base text-foreground">{label}</span>
      {children}
      {hint && (
        <span className="mt-1 block text-ui-caption text-foreground-subtlest">
          {hint}
        </span>
      )}
    </label>
  );
}

function GeneralSection({
  theme,
  onTheme,
}: {
  theme: "dark" | "light";
  onTheme: (theme: "dark" | "light") => void;
}) {
  return (
    <div>
      <SectionTitle>通用</SectionTitle>
      <Field label="主题">
        <div className="flex gap-1.5">
          <Button
            variant={theme === "light" ? "secondary" : "outline"}
            size="sm"
            onClick={() => onTheme("light")}
          >
            <SunIcon />
            浅色
          </Button>
          <Button
            variant={theme === "dark" ? "secondary" : "outline"}
            size="sm"
            onClick={() => onTheme("dark")}
          >
            <MoonIcon />
            深色
          </Button>
        </div>
      </Field>
    </div>
  );
}

function ProvidersSection() {
  const [settings, setSettings] = useState<DesktopSettingsSnapshot>();
  const [id, setId] = useState("");
  const [type, setType] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [credential, setCredential] = useState<
    "keep" | "replace" | "clear" | "environment"
  >("keep");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = () =>
    window.desktop.call("settings", undefined).then(setSettings);
  useEffect(() => {
    void load().catch((error) => {
      setMessage(error.message);
    });
  }, []);
  const select = (value: string, snapshot = settings) => {
    setId(value);
    const provider = snapshot?.providers.find((item) => item.id === value);
    setType(provider?.type ?? "openai");
    setBaseUrl(provider?.baseUrl ?? "");
    setModel(provider?.defaultModel ?? "");
    setSecret("");
    setCredential("keep");
    setMessage("");
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await operation();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
      setSecret("");
    }
  };
  const save = () =>
    run(async () => {
      if (!settings) return;
      const edit: ProviderSettingsEdit = {
        revision: settings.revision,
        id,
        patch: {
          type,
          baseUrl:
            settings.providers.find((provider) => provider.id === id)
              ?.baseUrlRedacted && !baseUrl
              ? undefined
              : baseUrl || null,
          defaultModel: model || null,
        },
        credential:
          credential === "replace"
            ? { action: "replace", value: secret }
            : credential === "environment"
              ? { action: "environment", name: secret }
              : { action: credential },
      };
      setSettings(await window.desktop.call("saveProvider", edit));
      setCredential("keep");
      setMessage("已保存至远端；下一次模型请求生效。");
    });
  return (
    <div>
      <SectionTitle>模型与 Provider</SectionTitle>
      <div className="grid grid-cols-[10rem_1fr] gap-4">
        <nav className="flex flex-col gap-0.5">
          <Button variant="outline" size="sm" onClick={() => select("")}>
            ＋ 添加 Provider
          </Button>
          {settings?.providers.map((provider) => (
            <button
              key={provider.id}
              onClick={() => select(provider.id)}
              aria-current={id === provider.id}
              className={cn(
                "flex flex-col rounded-md px-2 py-1.5 text-left outline-none hover:bg-hover",
                id === provider.id && "bg-selected",
              )}
            >
              <span className="truncate text-ui-base text-foreground">
                {provider.id}
              </span>
              <span className="text-ui-caption text-foreground-subtlest">
                {provider.credential.configured ? "已配置" : "未配置"} ·{" "}
                {provider.credential.kind}
              </span>
            </button>
          ))}
        </nav>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label="Provider ID">
            <Input
              value={id}
              onChange={(event) => setId(event.target.value)}
              required
            />
          </Field>
          <Field label="协议">
            <Input
              value={type}
              onChange={(event) => setType(event.target.value)}
              list="provider-types"
              required
            />
            <datalist id="provider-types">
              <option value="openai" />
              <option value="anthropic" />
              <option value="google" />
            </datalist>
          </Field>
          <Field label="Base URL">
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </Field>
          <Field label="默认模型">
            <Input
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </Field>
          <Field label="凭据操作">
            <Select
              aria-label="凭据操作"
              value={credential}
              onChange={(event) => {
                setCredential(event.target.value as typeof credential);
                setSecret("");
              }}
            >
              <option value="keep">保留现有凭据</option>
              <option value="replace">替换 API Key</option>
              <option value="environment">引用远端环境变量</option>
              <option value="clear">清除凭据</option>
            </Select>
          </Field>
          {(credential === "replace" || credential === "environment") && (
            <Field
              label={credential === "replace" ? "新 API Key" : "环境变量名"}
            >
              <Input
                type={credential === "replace" ? "password" : "text"}
                autoComplete="off"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                required
              />
            </Field>
          )}
          <div className="flex gap-1.5">
            <Button size="sm" disabled={busy || !settings}>
              保存到远端
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const snapshot = await window.desktop.call(
                    "settings",
                    undefined,
                  );
                  setSettings(snapshot);
                  select(id, snapshot);
                  setMessage("已重新读取远端配置，请核对后再保存。");
                })
              }
            >
              重新读取
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !id || !settings}
              onClick={() =>
                void run(async () => {
                  setSettings(
                    await window.desktop.call("removeProvider", {
                      id,
                      revision: settings!.revision,
                    }),
                  );
                  select("");
                })
              }
            >
              删除
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !model || !id}
              title="测试会从远端发起一条真实模型请求，可能产生费用"
              onClick={() =>
                void run(async () => {
                  setMessage(
                    await window.desktop.call("testProvider", {
                      model: `${id}/${model}`,
                    }),
                  );
                })
              }
            >
              测试连接
            </Button>
          </div>
          <p role="status" className="mt-2 text-ui-caption text-foreground-subtle">
            {message}
          </p>
        </form>
      </div>
    </div>
  );
}

function ConnectionSection({
  hosts,
  onHostsChanged,
}: {
  hosts?: HostListView;
  onHostsChanged: (hosts: HostListView) => void;
}) {
  const [executable, setExecutable] = useState("");
  const [homeDir, setHomeDir] = useState("");
  const [dialog, setDialog] = useState<RemoteHostView | "new" | undefined>();
  const [message, setMessage] = useState("");
  useEffect(() => {
    setExecutable(hosts?.local.executable ?? "");
    setHomeDir(hosts?.local.homeDir ?? "");
  }, [hosts]);
  const saveLocal = async () => {
    try {
      onHostsChanged(
        await window.desktop.call("setLocalConfig", {
          executable: executable || undefined,
          homeDir: homeDir || undefined,
        }),
      );
      setMessage("已保存本机连接设置。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    }
  };
  return (
    <div>
      <SectionTitle>连接</SectionTitle>
      <h3 className="mb-2 text-ui-base font-medium text-foreground">本机</h3>
      <Field label="VSPi 可执行文件" hint="留空时自动探测开发构建或 PATH 中的 vspi">
        <Input
          value={executable}
          onChange={(event) => setExecutable(event.target.value)}
          placeholder="vspi"
        />
      </Field>
      <Field label="数据目录" hint="留空时使用默认 VSPi 数据目录">
        <Input
          value={homeDir}
          onChange={(event) => setHomeDir(event.target.value)}
          placeholder="~/.vspi"
        />
      </Field>
      <Field label="启动命令">
        <code className="block rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-ui-caption text-foreground-subtle">
          {hosts?.local.resolvedCommand ?? "…"}
        </code>
      </Field>
      <Button size="sm" onClick={() => void saveLocal()}>
        保存本机设置
      </Button>
      {message && (
        <p role="status" className="mt-2 text-ui-caption text-foreground-subtle">
          {message}
        </p>
      )}
      <h3 className="mt-6 mb-2 text-ui-base font-medium text-foreground">
        远程主机
      </h3>
      <div className="flex flex-col gap-1">
        {hosts?.remotes.map((remote) => (
          <div
            key={remote.id}
            className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
          >
            <ServerIcon className="size-4 shrink-0 text-foreground-subtle" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui-base text-foreground">
                {remote.label}
              </span>
              <span className="block truncate text-ui-caption text-foreground-subtlest">
                ssh {remote.host}
                {remote.port ? ` -p ${remote.port}` : ""} ·{" "}
                {remote.executable ?? "vspi"}
              </span>
            </span>
            <Button
              variant="outline"
              size="xs"
              onClick={() => setDialog(remote)}
            >
              编辑
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                void window.desktop
                  .call("removeRemote", { id: remote.id })
                  .then(onHostsChanged)
              }
            >
              移除
            </Button>
          </div>
        ))}
        {hosts?.remotes.length === 0 && (
          <p className="text-ui-caption text-foreground-subtle">
            还没有远程主机。
          </p>
        )}
        <div>
          <Button
            variant="outline"
            size="sm"
            className="mt-1"
            onClick={() => setDialog("new")}
          >
            添加远程主机…
          </Button>
        </div>
      </div>
      {dialog && (
        <RemoteHostDialog
          remote={dialog === "new" ? undefined : dialog}
          onSaved={(next) => {
            onHostsChanged(next);
            setDialog(undefined);
          }}
          onClose={() => setDialog(undefined)}
        />
      )}
    </div>
  );
}

function AboutSection({ connection }: { connection?: ConnectionInfo }) {
  return (
    <div>
      <SectionTitle>关于</SectionTitle>
      <dl className="grid grid-cols-[7rem_1fr] gap-y-2 text-ui-base">
        <dt className="text-foreground-subtle">主机</dt>
        <dd className="text-foreground">
          {connection ? `${connection.label}（${connection.host}）` : "未连接"}
        </dd>
        <dt className="text-foreground-subtle">运行时版本</dt>
        <dd className="font-mono text-foreground">
          {connection?.version ?? "—"}
        </dd>
        <dt className="text-foreground-subtle">数据目录</dt>
        <dd className="truncate font-mono text-ui-caption text-foreground">
          {connection?.homeDir ?? "—"}
        </dd>
      </dl>
      <p className="mt-6 text-ui-caption text-foreground-subtle">
        界面设计参照 ZCode（zai-org/ZCode，Apache-2.0）实现。
      </p>
    </div>
  );
}
