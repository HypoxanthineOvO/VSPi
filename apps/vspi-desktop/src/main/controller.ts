import { randomUUID } from "node:crypto";
import type {
  AgentHandle,
  SessionHandle,
  TerminalStreamFrame,
} from "@moonshot-ai/klient";
import { providerSettingsEditSchema } from "@moonshot-ai/klient/contract/global/settings";
import { z } from "zod";
import { connectSsh, sshAliases } from "./ssh.js";
import { connectLocal } from "./local.js";
import type { Runtime } from "./runtime.js";
import {
  describeLocalCommand,
  loadHosts,
  localConfigSchema,
  remoteInputSchema,
  resolveLocalCommand,
  saveHosts,
  type HostsFile,
} from "./hosts.js";
import type {
  AgentHistoryPage,
  AgentToolTaskView,
  DesktopEvent,
  HostListView,
  LocalConfigView,
  RemoteHostView,
  SessionView,
} from "../shared.js";
const id = z.string().min(1).max(512);
const sessionInput = z.object({ sessionId: id });
const pathInput = sessionInput.extend({ path: z.string().min(1).max(4096) });
const dimensions = {
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
};
export interface ControllerOptions {
  hostsPath: string;
  appPath: string;
}
export class DesktopController {
  private runtime?: Runtime;
  private connecting?: AbortController;
  private generation = 0;
  private viewGeneration = 0;
  private watch?: AsyncIterator<unknown>;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private refreshRunning = false;
  private lastViewSignature?: string;
  private hosts?: HostsFile;
  private activeHostId = "local";
  private readonly terminals = new Map<
    string,
    AsyncIterator<TerminalStreamFrame>
  >();
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly emit: (event: DesktopEvent) => void,
    private readonly options: ControllerOptions,
  ) {}
  async disconnect(): Promise<void> {
    this.generation++;
    this.connecting?.abort();
    this.connecting = undefined;
    await this.teardownCurrent();
  }
  private async teardownCurrent(): Promise<void> {
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    const watch = this.watch;
    this.watch = undefined;
    const runtime = this.runtime;
    this.runtime = undefined;
    this.viewGeneration++;
    this.lastViewSignature = undefined;
    const streams = [...this.terminals.values()];
    this.terminals.clear();
    await Promise.allSettled([
      watch?.return?.(),
      ...streams.map((stream) => stream.return?.()),
      runtime?.close(),
    ]);
  }
  private get connected(): Runtime {
    if (!this.runtime) throw new Error("运行时未连接");
    return this.runtime;
  }
  private async ensureHosts(): Promise<HostsFile> {
    this.hosts ??= await loadHosts(this.options.hostsPath, (backupName) =>
      this.emit({
        type: "error",
        message: `主机配置无法解析，已备份为 ${backupName}，已使用默认配置`,
      }),
    );
    return this.hosts;
  }
  private hostList(hosts: HostsFile): HostListView {
    const command = resolveLocalCommand(
      hosts.local,
      this.env,
      this.options.appPath,
    );
    return {
      active: this.activeHostId,
      local: {
        ...hosts.local,
        resolvedCommand: describeLocalCommand(command, hosts.local.homeDir),
      },
      remotes: hosts.remotes,
    };
  }
  private async connectHost(hostId: string): Promise<Runtime["info"]> {
    const hosts = await this.ensureHosts();
    const remote =
      hostId === "local"
        ? undefined
        : hosts.remotes.find((entry) => entry.id === hostId);
    if (hostId !== "local" && !remote) throw new Error("主机不存在");
    this.connecting?.abort();
    const abort = new AbortController();
    this.connecting = abort;
    const generation = ++this.generation;
    const onDisconnect = () => {
      if (generation === this.generation) {
        this.emit({
          type: "connection",
          message: "连接已断开。远端任务仍由运行时管理，可重新连接。",
          disconnected: true,
        });
        void this.disconnect();
      }
    };
    const progress = (message: string) => {
      this.emit({ type: "connection", message });
    };
    let runtime: Runtime;
    if (hostId === "local") {
      const localCommand = resolveLocalCommand(
        hosts.local,
        this.env,
        this.options.appPath,
      );
      runtime = await connectLocal(
        {
          executable: localCommand.executable,
          executableArgs: localCommand.executableArgs,
          homeDir: hosts.local.homeDir,
          label: "本机",
        },
        this.env,
        abort.signal,
        progress,
        onDisconnect,
      );
    } else {
      runtime = await connectSsh(
        {
          host: remote!.host,
          port: remote!.port,
          executable: remote!.executable,
          homeDir: remote!.homeDir,
          label: remote!.label,
        },
        this.env,
        abort.signal,
        progress,
        onDisconnect,
      );
    }
    if (generation !== this.generation || abort.signal.aborted) {
      await runtime.close();
      throw new Error("连接已取消");
    }
    // Only drop the working connection once the replacement is ready, so a
    // failed switch leaves the previous host usable.
    await this.teardownCurrent();
    if (generation !== this.generation) {
      await runtime.close();
      throw new Error("连接已取消");
    }
    this.runtime = runtime;
    this.activeHostId = hostId;
    if (this.connecting === abort) this.connecting = undefined;
    return runtime.info;
  }
  async call(method: string, input: unknown): Promise<unknown> {
    if (method === "aliases") return sshAliases();
    if (method === "disconnect") return this.disconnect();
    if (method === "connectHost") {
      const { id: hostId } = z.object({ id }).parse(input);
      return this.connectHost(hostId);
    }
    if (method === "listHosts") return this.hostList(await this.ensureHosts());
    if (method === "upsertRemote") {
      const parsed = remoteInputSchema.parse(input);
      const hosts = await this.ensureHosts();
      const remote: RemoteHostView = {
        ...parsed,
        id: parsed.id ?? randomUUID().slice(0, 8),
      };
      const index = hosts.remotes.findIndex((entry) => entry.id === remote.id);
      if (index < 0) hosts.remotes.push(remote);
      else hosts.remotes[index] = remote;
      await saveHosts(this.options.hostsPath, hosts);
      return this.hostList(hosts);
    }
    if (method === "removeRemote") {
      const { id: hostId } = z.object({ id }).parse(input);
      const hosts = await this.ensureHosts();
      hosts.remotes = hosts.remotes.filter((entry) => entry.id !== hostId);
      await saveHosts(this.options.hostsPath, hosts);
      return this.hostList(hosts);
    }
    if (method === "setLocalConfig") {
      const config: LocalConfigView = localConfigSchema.parse(input);
      const hosts = await this.ensureHosts();
      hosts.local = {
        executable: config.executable || undefined,
        executableArgs:
          config.executableArgs && config.executableArgs.length > 0
            ? config.executableArgs
            : undefined,
        homeDir: config.homeDir || undefined,
      };
      await saveHosts(this.options.hostsPath, hosts);
      return this.hostList(hosts);
    }
    const runtime = this.connected;
    const klient = runtime.klient;
    if (method === "workspaces") return klient.global.workspaces.list();
    if (method === "browse") {
      let { path } = z
        .object({ path: z.string().max(4096).optional() })
        .parse(input);
      if (path === "~" || path?.startsWith("~/")) {
        const home = await klient.global.hostFs.home();
        path = home.home + path.slice(1);
      }
      return klient.global.hostFs.browse(path);
    }
    if (method === "sessions") {
      const data = z
        .object({ workspaceId: id.optional(), before: z.string().optional() })
        .parse(input);
      return klient.global.sessions.list({
        workspaceIds: data.workspaceId ? [data.workspaceId] : undefined,
        before: data.before,
        limit: 50,
      });
    }
    if (method === "create") {
      const data = z.object({ path: z.string().min(1).max(4096) }).parse(input);
      return (await klient.global.sessions.create({ workDir: data.path })).id;
    }
    if (method === "models") return klient.global.kosong.listModels();
    if (method === "settings") return klient.global.settings.read();
    if (method === "saveProvider")
      return (
        await klient.global.settings.saveProvider(
          providerSettingsEditSchema.parse(input),
        )
      ).settings;
    if (method === "removeProvider")
      return (
        await klient.global.settings.removeProvider(
          z.object({ revision: id, id }).parse(input),
        )
      ).settings;
    if (method === "testProvider") {
      const { model } = z.object({ model: id }).parse(input);
      try {
        for await (const event of klient.global.kosong.generate(
          model,
          {
            systemPrompt: "",
            tools: [],
            messages: [
              {
                role: "user",
                toolCalls: [],
                content: [{ type: "text", text: "Reply OK." }],
              },
            ],
          },
          { maxCompletionTokens: 8 },
        )) {
          if (event.type === "finish") return "远端模型请求成功";
        }
        throw new Error("Invalid response");
      } catch (error) {
        throw new Error(
          "远端模型请求失败，请检查 Provider 配置、凭据和网络。",
          { cause: error },
        );
      }
    }
    if (method === "terminalClose") {
      const { streamId } = z.object({ streamId: id }).parse(input);
      const stream = this.terminals.get(streamId);
      this.terminals.delete(streamId);
      await stream?.return?.();
      return;
    }
    const { sessionId } = sessionInput.parse(input);
    const session = klient.session(sessionId);
    const agent = session.agent("main");
    switch (method) {
      case "open": {
        const generation = ++this.viewGeneration;
        this.lastViewSignature = undefined;
        await this.watch?.return?.();
        if (generation !== this.viewGeneration) throw new Error("会话已切换");
        clearInterval(this.refreshTimer);
        if (!(await session.restore())) throw new Error("会话不存在");
        if (generation !== this.viewGeneration) throw new Error("会话已切换");
        if (!(await agent.getModel())) {
          const defaultModel = await klient.global.config.get<
            string | undefined
          >("defaultModel");
          if (defaultModel) await agent.setModel(defaultModel);
        }
        if (generation !== this.viewGeneration) throw new Error("会话已切换");
        const source = agent.watchHistory({ limit: 100 });
        const iterator = source[Symbol.asyncIterator]();
        this.watch = iterator;
        let dirty = true;
        let ticks = 0;
        void (async () => {
          try {
            while (!(await iterator.next()).done) dirty = true;
          } catch {
            if (this.watch === iterator)
              this.emit({
                type: "connection",
                message: "会话事件连接已中断，请重新连接。",
                disconnected: true,
              });
          }
        })();
        this.refreshTimer = setInterval(() => {
          if (++ticks % 10 === 0) dirty = true;
          if (
            !dirty ||
            this.refreshRunning ||
            generation !== this.viewGeneration
          )
            return;
          dirty = false;
          this.refreshRunning = true;
          void this.view(session, agent)
            .then((view) => {
              if (generation !== this.viewGeneration) return;
              const signature = JSON.stringify(view);
              if (signature === this.lastViewSignature) return;
              this.lastViewSignature = signature;
              this.emit({ type: "session", sessionId, view });
            })
            .catch(() => {
              dirty = true;
            })
            .finally(() => {
              this.refreshRunning = false;
            });
        }, 150);
        return this.view(session, agent);
      }
      case "history":
        return agent.getHistory({
          before: z.object({ before: z.number().int().optional() }).parse(input)
            .before,
          limit: 100,
        });
      case "rename":
        return session.setTitle(
          z.object({ title: z.string().min(1).max(256) }).parse(input).title,
        );
      case "archive":
        return session.archive();
      case "submit": {
        const data = sessionInput
          .extend({
            promptId: id,
            text: z
              .string()
              .min(1)
              .max(128 * 1024),
            mode: z.enum(["queue", "steer"]),
          })
          .parse(input);
        return agent.submitOnce({
          promptId: data.promptId,
          input: [{ type: "text", text: data.text }],
          mode: data.mode,
        });
      }
      case "receipt":
        return agent.getSubmission(
          z.object({ promptId: id }).parse(input).promptId,
        );
      case "stop":
        return agent.cancel();
      case "approve": {
        const data = z
          .object({ id, decision: z.enum(["approved", "rejected"]) })
          .parse(input);
        return session.approvals.decide(data.id, { decision: data.decision });
      }
      case "answer": {
        const data = z
          .object({ id, answers: z.record(z.string(), z.string()) })
          .parse(input);
        return session.questions.answer(data.id, { answers: data.answers });
      }
      case "model": {
        const data = z
          .object({ model: id, thinking: z.string().max(32).optional() })
          .parse(input);
        return agent.setModel(data.model, data.thinking);
      }
      case "permission":
        return agent.setPermission(
          z.object({ mode: z.enum(["auto", "manual", "yolo"]) }).parse(input)
            .mode,
        );
      case "files":
        return runtime.request(
          `/sessions/${encodeURIComponent(sessionId)}/fs:list`,
          {
            path: pathInput.parse(input).path,
            limit: 200,
            depth: 1,
            show_hidden: true,
          },
        );
      case "preview": {
        const { path } = pathInput.parse(input);
        const image = /\.(png|jpe?g|gif|webp)$/i.test(path);
        return runtime.request(
          `/sessions/${encodeURIComponent(sessionId)}/fs:read`,
          {
            path,
            length: image ? 2 * 1024 * 1024 : 256 * 1024,
            encoding: image ? "base64" : "auto",
          },
        );
      }
      case "changes":
        return runtime.request(
          `/sessions/${encodeURIComponent(sessionId)}/fs:git_status`,
          {},
        );
      case "diff":
        return runtime.request(
          `/sessions/${encodeURIComponent(sessionId)}/fs:diff`,
          { path: pathInput.parse(input).path },
        );
      case "terminalOpen": {
        const data = sessionInput
          .extend({ streamId: id, ...dimensions })
          .parse(input);
        if (this.terminals.has(data.streamId) || this.terminals.size >= 8)
          throw new Error("终端已存在或数量超过 8 个");
        const source = session.terminals.open({
          cols: data.cols,
          rows: data.rows,
        });
        const iterator = source[Symbol.asyncIterator]();
        this.terminals.set(data.streamId, iterator);
        void (async () => {
          try {
            for (;;) {
              const next = await iterator.next();
              if (next.done) break;
              this.emit({
                type: "terminal",
                streamId: data.streamId,
                frame: next.value,
              });
            }
          } catch (error) {
            if (this.terminals.get(data.streamId) !== iterator) return;
            this.emit({
              type: "error",
              streamId: data.streamId,
              message:
                error instanceof Error
                  ? `终端连接失败：${error.message.slice(0, 500)}`
                  : "远端终端已断开，可重新创建终端。",
            });
          } finally {
            if (this.terminals.get(data.streamId) === iterator)
              this.terminals.delete(data.streamId);
          }
        })();
        return;
      }
      case "terminalWrite": {
        const data = z
          .object({ id, data: z.string().max(64 * 1024) })
          .parse(input);
        return session.terminals.write(data);
      }
      case "terminalResize": {
        const data = z.object({ id, ...dimensions }).parse(input);
        return session.terminals.resize(data);
      }
      default:
        throw new Error("不支持的桌面操作");
    }
  }
  private async view(
    session: SessionHandle,
    agent: AgentHandle,
  ): Promise<SessionView> {
    const [history, approvals, questions, permission] = await Promise.all([
      agent.getHistory({ limit: 100 }),
      session.approvals.list(),
      session.questions.list(),
      agent.getPermission(),
    ]);
    const agentDetails = await this.collectAgentDetails(history.items, agent);
    return {
      history,
      agentOutputs: agentDetails.outputs,
      agentTasks: agentDetails.tasks,
      approvals,
      questions,
      permission,
    };
  }
  private async collectAgentDetails(
    items: AgentHistoryPage["items"],
    agent: AgentHandle,
  ): Promise<{
    outputs: Record<string, string>;
    tasks: Record<string, AgentToolTaskView>;
  }> {
    const callNames = new Map<string, string>();
    const taskByCall = new Map<string, string>();
    for (const item of items) {
      if (item.role === "assistant") {
        for (const call of item.toolCalls) callNames.set(call.id, call.name);
        continue;
      }
      if (item.role !== "tool" || item.toolCallId === undefined) continue;
      const text = item.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      const match = /^task_id:\s*(\S+)/m.exec(text);
      if (match?.[1] !== undefined) taskByCall.set(item.toolCallId, match[1]);
    }
    const outputs: Record<string, string> = {};
    const tasks: Record<string, AgentToolTaskView> = {};
    await Promise.all(
      [...taskByCall]
        .filter(([callId]) => callNames.get(callId) === "Agent")
        .map(async ([callId, taskId]) => {
          try {
            const info = await agent.getTask(taskId);
            if (info !== undefined && info.kind === "agent")
              tasks[callId] = {
                description: info.description,
                subagentType: info.subagentType,
                model: info.model,
              };
          } catch {}
          try {
            const output = (
              await agent.getTaskOutput({ taskId, tail: 8192 })
            ).trim();
            if (output.length > 0) outputs[callId] = output;
          } catch {}
        }),
    );
    return { outputs, tasks };
  }
}
