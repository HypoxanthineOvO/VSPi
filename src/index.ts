#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Terminal, TUI } from "@earendil-works/pi-tui";
import { runAuthSetup } from "./app/auth-setup.js";
import { shutdownInteractiveSession, startUiAfterSplash } from "./app/startup.js";
import { VspiApp } from "./app/vspi-app.js";
import { AttachmentBridge } from "./attachments/bridge.js";
import { AttachmentService } from "./attachments/service.js";
import { AttachmentStore } from "./attachments/store.js";
import { AdaptiveBackend, type BackendMode } from "./backend/adaptive-backend.js";
import { createRuntimeDefaultsService } from "./config/runtime-defaults.js";
import { loadSettings } from "./config/settings.js";
import type { TranscriptMessage } from "./domain/types.js";
import { createStartupLocalPlanBackend } from "./plans/startup.js";
import { createPolicyConfigService } from "./policy/config-service.js";
import type { ExecutionPolicyService } from "./policy/execution-policy.js";
import {
  createInteractiveApprovalBroker,
  createStartupPolicyRuntime,
  createYoloAcknowledgementBroker,
  type InteractiveApprovalBroker,
  type YoloAcknowledgementBroker,
} from "./policy/startup-runtime.js";
import { resolveStartupSecurity, type StartupSecuritySnapshot } from "./policy/startup-security.js";
import { createPromptProfileService } from "./prompts/profile-service.js";
import { BUILTIN_PROVIDERS } from "./providers/builtins.js";
import { createProviderConfigService } from "./providers/config-service.js";
import { applySettingsToCapabilities, detectTerminalCapabilities } from "./ui/capabilities.js";
import { ScrollbackProcessTerminal, ScrollbackTUI } from "./ui/scrollback-terminal.js";
import { createTheme } from "./ui/theme.js";
import { updateVspi } from "./update/self-update.js";
import { VSPI_VERSION } from "./version.js";
import { createStartupWorkflowAdapter } from "./workflow/startup.js";
import type { WorkflowAdapter } from "./workflow/types.js";

class HeadlessTerminal implements Terminal {
  readonly kittyProtocolActive = false;
  columns = 80;
  rows = 24;
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

async function renderOnce(): Promise<void> {
  const workspace = process.cwd();
  const { security, executionPolicy, approvalBroker, yoloAcknowledgementBroker, workflowAdapter } =
    await startupPolicy(workspace);
  const terminal = new HeadlessTerminal();
  const tui = new TUI(terminal);
  const settings = await loadSettings(workspace, undefined, { trustedProject: security.trustedProject });
  const detected = { ...detectTerminalCapabilities(), reducedMotion: true, ssh: false };
  const capabilities = applySettingsToCapabilities(detected, settings);
  const theme = createTheme(capabilities, settings.theme);
  const attachments = new AttachmentService(randomUUID(), capabilities, theme);
  const promptProfileService = createPromptProfileService({
    cwd: workspace,
    home: process.env.HOME ?? homedir(),
    trustedProject: security.trustedProject,
  });
  await promptProfileService.load();
  const localPlanBackend = createStartupLocalPlanBackend({
    workspace,
    recovery: security.recovery,
    workflow: security.workflowAdapter,
  });
  const backend = new AdaptiveBackend(
    workspace,
    resolveBackendMode(),
    security.trustedProject,
    security.recovery,
    executionPolicy,
    localPlanBackend,
    { resolve: async (identity) => promptProfileService.resolve(identity) },
    {
      continueRecent: startupSessionMode().continueRecent,
      ...(security.workflowAdapter ? { workflowPlan: workflowAdapter } : {}),
    },
  );
  const app = new VspiApp(tui, theme, backend, {
    cwd: workspace,
    settings,
    attachments,
    executionPolicy,
    approvalBroker,
    yoloAcknowledgementBroker,
    providerConfigFactory: (trustedProject) =>
      createProviderConfigService({
        cwd: workspace,
        agentDir: getAgentDir(),
        trustedProject,
        builtins: BUILTIN_PROVIDERS,
      }),
    runtimeDefaultsFactory: (trustedProject) => createRuntimeDefaultsService({ cwd: workspace, trustedProject }),
    ...(localPlanBackend ? { planBackend: localPlanBackend } : {}),
    ...(security.workflowAdapter ? { workflowAdapter } : {}),
    promptProfiles: promptProfileService,
    onExit() {},
  });
  tui.addChild(app);
  tui.setFocus(app);
  try {
    await startUiAfterSplash({
      width: terminal.columns,
      theme,
      write: (chunk) => process.stdout.write(chunk),
      startApp: async () => {
        await app.start();
        return app.startupStatus();
      },
      startTui: () => {
        process.stdout.write(`${app.render(terminal.columns).join("\n")}\n`);
      },
    });
  } finally {
    await app.dispose();
  }
}

async function interactive(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("VSPi interactive mode requires a TTY. Use --render-once for a non-interactive smoke render.");
  }
  const workspace = process.cwd();
  const { security, executionPolicy, approvalBroker, yoloAcknowledgementBroker, workflowAdapter } =
    await startupPolicy(workspace);
  const terminal = new ScrollbackProcessTerminal();
  const tui = new ScrollbackTUI(terminal, true);
  const settings = await loadSettings(workspace, undefined, { trustedProject: security.trustedProject });
  const capabilities = applySettingsToCapabilities(detectTerminalCapabilities(), settings);
  const theme = createTheme(capabilities, settings.theme);
  let closing = false;
  let foregroundAttached = true;
  const mode = resolveBackendMode();
  const promptProfileService = createPromptProfileService({
    cwd: workspace,
    home: process.env.HOME ?? homedir(),
    trustedProject: security.trustedProject,
  });
  await promptProfileService.load();
  const sessionMode = startupSessionMode();
  const localPlanBackend = createStartupLocalPlanBackend({
    workspace,
    recovery: security.recovery,
    workflow: security.workflowAdapter,
  });
  const backend = new AdaptiveBackend(
    workspace,
    mode,
    security.trustedProject,
    security.recovery,
    executionPolicy,
    localPlanBackend,
    { resolve: async (identity) => promptProfileService.resolve(identity) },
    {
      continueRecent: sessionMode.continueRecent,
      ...(security.workflowAdapter ? { workflowPlan: workflowAdapter } : {}),
    },
  );
  const attachments = new AttachmentService(randomUUID(), capabilities, theme);
  const app = new VspiApp(tui, theme, backend, {
    cwd: workspace,
    settings,
    attachments,
    executionPolicy,
    approvalBroker,
    yoloAcknowledgementBroker,
    providerConfigFactory: (trustedProject) =>
      createProviderConfigService({
        cwd: workspace,
        agentDir: getAgentDir(),
        trustedProject,
        builtins: BUILTIN_PROVIDERS,
      }),
    runtimeDefaultsFactory: (trustedProject) => createRuntimeDefaultsService({ cwd: workspace, trustedProject }),
    ...(localPlanBackend ? { planBackend: localPlanBackend } : {}),
    ...(security.workflowAdapter ? { workflowAdapter } : {}),
    promptProfiles: promptProfileService,
    ...(sessionMode.openOnStart ? { openOnStart: sessionMode.openOnStart } : {}),
    onForegroundRelinquish: () => {
      if (!foregroundAttached) return;
      app.getActiveTui().stop();
      foregroundAttached = false;
      void terminal.drainInput();
    },
    onForegroundResume: () => {
      if (foregroundAttached || closing) return;
      app.getActiveTui().start();
      foregroundAttached = true;
      app.getActiveTui().requestRender(true);
    },
    onExit: () => void shutdown(),
  });

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGHUP", terminate);
    await shutdownInteractiveSession({
      disposeApp: () => app.dispose(),
      tui: app.getActiveTui(),
      drainInput: () => terminal.drainInput(),
    });
  };

  const terminate = () => void shutdown();
  process.once("SIGTERM", terminate);
  process.once("SIGHUP", terminate);

  tui.addChild(app);
  tui.setFocus(app);
  terminal.setTitle("VSPi");
  try {
    await startUiAfterSplash({
      width: terminal.columns,
      theme,
      write: (chunk) => terminal.write(chunk),
      commitStatic: (lines) => terminal.commitStatic(lines),
      startApp: async () => {
        await app.start();
        return app.startupStatus();
      },
      startTui: async () => {
        app.commitStableTranscript();
        app.getActiveTui().start();
        if (sessionMode.initialCommand) await app.runStartupCommand(sessionMode.initialCommand);
      },
    });
  } catch (error) {
    await shutdown();
    throw error;
  }
}

function resolveBackendMode(): BackendMode {
  return process.env.VSPi_FIXTURE === "1" || process.env.VSPi_BACKEND === "fixture" ? "fixture" : "pi";
}

async function startupPolicy(workspace: string): Promise<{
  security: StartupSecuritySnapshot;
  executionPolicy: ExecutionPolicyService;
  approvalBroker: InteractiveApprovalBroker;
  yoloAcknowledgementBroker: YoloAcknowledgementBroker;
  workflowAdapter: WorkflowAdapter;
}> {
  const argv = process.argv.slice(2);
  const preliminary = resolveStartupSecurity({ argv });
  const configService = createPolicyConfigService({
    cwd: workspace,
    home: process.env.HOME ?? homedir(),
    trustedProject: preliminary.trustedProject,
    recovery: preliminary.recovery,
  });
  const config = await configService.load();
  const security = resolveStartupSecurity({
    argv,
    globalPolicy: config.globalPolicy,
    ...(config.projectPolicy ? { projectPolicy: config.projectPolicy } : {}),
  });
  const yoloAcknowledgementBroker = createYoloAcknowledgementBroker();
  const approvalBroker = createInteractiveApprovalBroker();
  const workflowAdapter = await createStartupWorkflowAdapter({
    enabled: security.workflowAdapter,
    workspace,
    disabledReason: security.recovery ? "recovery" : "not-enabled",
  });
  const executionPolicy = await createStartupPolicyRuntime({
    workspace,
    security,
    configService: { load: async () => config },
    approvalBroker: (request, signal) => approvalBroker.request(request, signal),
    acknowledgeYolo: () => yoloAcknowledgementBroker.consume(),
    workflowAuthority: (action) => workflowAdapter.authorize(action),
  });
  return { security, executionPolicy, approvalBroker, yoloAcknowledgementBroker, workflowAdapter };
}

async function bridge(): Promise<void> {
  const store = new AttachmentStore(`bridge-${randomUUID()}`);
  await store.initialize();
  const server = new AttachmentBridge(store);
  await server.start();
  process.stdout.write(`${server.url}\n`);
  await new Promise<void>((resolve) => {
    const stop = () => void server.stop().then(resolve);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

/** 启动会话语义：默认新会话；`vspi continue` 续接最近会话；`vspi resume` 打开会话选择器。 */
function startupSessionMode(): {
  continueRecent: boolean;
  openOnStart?: "sessions" | "providers";
  initialCommand?: string;
} {
  const argv = process.argv.slice(2);
  return {
    continueRecent: argv[0] === "continue",
    ...(argv[0] === "resume" ? { openOnStart: "sessions" as const } : {}),
    ...(argv[0] === "init" ? { openOnStart: "providers" as const } : {}),
    ...(argv[0] === "import"
      ? { initialCommand: ["/import", argv[1]].filter(Boolean).join(" ") }
      : argv[0] === "skills" || argv[0] === "skill"
        ? { initialCommand: "/skills" }
        : argv[0] === "login"
          ? { initialCommand: ["/login", argv[1]].filter(Boolean).join(" ") }
          : argv[0] === "logout"
            ? { initialCommand: ["/logout", argv[1]].filter(Boolean).join(" ") }
            : {}),
  };
}

function printHelp(): void {
  process.stdout.write(`vspi ${VSPI_VERSION} — VSPi 中文 TUI AI 编程助手

用法：
  vspi                     启动新会话（交互 TUI）
  vspi init                打开首次配置与 Provider 登录
  vspi login [provider]    登录订阅账号或保存 API Key
  vspi logout [provider]   移除 Pi 保存的 Provider 凭据
  vspi continue            续接最近的会话
  vspi resume              启动后进入会话选择器
  vspi import [codex|claude]
                            导入外部 Agent 的历史会话
  vspi skills               管理、安装与导入 Skill
  vspi run "<prompt>"      非交互模式：执行单个 prompt，结果输出到 stdout
  vspi bridge              启动附件 Bridge（SSH 粘贴图片）
  vspi update              检查并安装最新稳定版本

选项：
  --policy <level>         Safe | Standard | YOLO | Auto（只控制审批强度）
  --trust-project          信任当前项目（读取 .vspi/ 配置与 Provider overlay）
  --workflow               启用只读 Workflow Plan 投影（默认关闭）
  --recovery               恢复模式：强制 Standard · Host，禁用项目资源与 Workflow
  --render-once            渲染一帧后退出（smoke 用）
  -h, --help               显示本帮助
  -v, --version            显示版本号

环境变量：
  VSPi_BACKEND=pi|fixture  选择后端（fixture 等价 VSPi_FIXTURE=1，完全离线）
  VSPI_WORKFLOW_*          --workflow 所需的完整 bundle identity（详见 README）
  Provider 凭据可用 vspi login 配置，或通过环境变量注入
`);
}

async function selfUpdate(): Promise<void> {
  process.stdout.write(`正在检查 VSPi ${VSPI_VERSION} 的更新...\n`);
  const result = await updateVspi(VSPI_VERSION);
  process.stdout.write(
    result.status === "updated"
      ? `已更新到 VSPi ${result.latestVersion}，请重新运行 vspi。\n`
      : `当前已是最新版本 ${result.currentVersion}。\n`,
  );
}

/** 非交互单次执行：发送一个 prompt，把最终的 assistant 文本写到 stdout。 */
async function runOnce(prompt: string): Promise<void> {
  if (!prompt.trim()) throw new Error('用法：vspi run "<prompt>"');
  const workspace = process.cwd();
  const { security, executionPolicy, workflowAdapter } = await startupPolicy(workspace);
  const promptProfileService = createPromptProfileService({
    cwd: workspace,
    home: process.env.HOME ?? homedir(),
    trustedProject: security.trustedProject,
  });
  await promptProfileService.load();
  const localPlanBackend = createStartupLocalPlanBackend({
    workspace,
    recovery: security.recovery,
    workflow: security.workflowAdapter,
  });
  const backend = new AdaptiveBackend(
    workspace,
    resolveBackendMode(),
    security.trustedProject,
    security.recovery,
    executionPolicy,
    localPlanBackend,
    { resolve: async (identity) => promptProfileService.resolve(identity) },
    {
      continueRecent: false,
      ...(security.workflowAdapter ? { workflowPlan: workflowAdapter } : {}),
    },
  );
  const messages: TranscriptMessage[] = [];
  try {
    await backend.start({
      onMessage: (message) => {
        messages.push(message);
      },
      onMessageUpdate: (id, patch) => {
        const index = messages.findIndex((message) => message.id === id);
        const current = messages[index];
        if (index >= 0 && current) messages[index] = { ...current, ...patch } as TranscriptMessage;
      },
      onBusy: () => {},
      onUsage: () => {},
      onNotice: (text, tone) => {
        if (tone === "error" || tone === "warning") process.stderr.write(`${text}\n`);
      },
      onSessionInvalidating: () => {},
      onSessionReset: () => {},
    });
    const result = await backend.send(prompt, { attachments: [], effort: "medium", behavior: "prompt" });
    const reply = [...messages].reverse().find((message) => message.role === "assistant" && message.kind === "text");
    if (reply && reply.kind === "text") process.stdout.write(`${reply.text}\n`);
    if (result && result.status === "cancelled") process.exitCode = 130;
  } finally {
    await backend.dispose();
  }
}

const entry = process.argv[2];
if (entry === "bridge") await bridge();
else if (entry === "run") await runOnce(process.argv.slice(3).join(" "));
else if (entry === "update") await selfUpdate();
else if (entry === "init" || entry === "login" || entry === "logout") {
  const settings = await loadSettings(process.cwd());
  await runAuthSetup({
    mode: entry === "logout" ? "logout" : "login",
    settings,
    ...(process.argv[3] ? { providerRef: process.argv[3] } : {}),
  });
} else if (entry === "--help" || entry === "-h") printHelp();
else if (entry === "--version" || entry === "-v") process.stdout.write(`${VSPI_VERSION}\n`);
else if (process.argv.includes("--render-once")) await renderOnce();
else await interactive();
