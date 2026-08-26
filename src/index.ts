#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { runAuthSetup } from "./app/auth-setup.js";
import { startParentDeathWatchdog } from "./app/parent-watchdog.js";
import { shutdownInteractiveSession, startUiAfterSplash } from "./app/startup.js";
import { VspiApp } from "./app/vspi-app.js";
import { AttachmentService } from "./attachments/service.js";
import { AdaptiveBackend } from "./backend/adaptive-backend.js";
import { resolveBackendMode } from "./backend/mode.js";
import { runExec } from "./cli/exec.js";
import { deepSeekHarnessEnabled } from "./config/deepseek-harness.js";
import { createRuntimeDefaultsService } from "./config/runtime-defaults.js";
import { loadSettings } from "./config/settings.js";
import { createStartupGoalBackend } from "./goals/startup.js";
import { createStartupLocalPlanBackend } from "./plans/startup.js";
import { composeStartupPolicy } from "./policy/startup-compose.js";
import { createPromptProfileService } from "./prompts/profile-service.js";
import { BUILTIN_PROVIDERS } from "./providers/builtins.js";
import { createProviderConfigService } from "./providers/config-service.js";
import { applySettingsToCapabilities, detectTerminalCapabilities } from "./ui/capabilities.js";
import { ScrollbackProcessTerminal, ScrollbackTUI } from "./ui/scrollback-terminal.js";
import { openTerminalUrl } from "./ui/terminal-link.js";
import { createTheme } from "./ui/theme.js";
import { VspiTuiAltScreen } from "./ui/tui-frame-pacer.js";
import { updateVspi } from "./update/self-update.js";
import { VSPI_VERSION } from "./version.js";

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
    await composeStartupPolicy(workspace);
  const terminal = new HeadlessTerminal();
  const tui = new TuiMainScreen(terminal);
  const settings = await loadSettings(workspace, undefined, { trustedProject: security.trustedProject });
  const detected = { ...detectTerminalCapabilities(), reducedMotion: true, ssh: false };
  const capabilities = applySettingsToCapabilities(detected, settings);
  const theme = createTheme(capabilities, settings.theme);
  const attachments = new AttachmentService(randomUUID(), theme);
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
  const goalBackend = createStartupGoalBackend({
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
      deepSeekHarness: deepSeekHarnessEnabled(),
      ...(security.workflowAdapter ? { workflowPlan: workflowAdapter } : {}),
    },
    goalBackend,
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
      startTui: (startupSurface) => {
        app.setStartupSurface(startupSurface);
        process.stdout.write(`${app.render(terminal.columns).join("\n")}\n`);
      },
    });
  } finally {
    await app.dispose();
  }
}

async function interactive(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("VSPi interactive mode requires a TTY. Use vspi exec for non-interactive runs.");
  }
  const workspace = process.cwd();
  const { security, executionPolicy, approvalBroker, yoloAcknowledgementBroker, workflowAdapter } =
    await composeStartupPolicy(workspace);
  const terminal = new ScrollbackProcessTerminal();
  const settings = await loadSettings(workspace, undefined, { trustedProject: security.trustedProject });
  const configuredTuiMode =
    process.env.VSPi_TUI_MODE === "regular" || process.env.VSPi_TUI_MODE === "fullscreen"
      ? process.env.VSPi_TUI_MODE
      : settings.tuiMode;
  const tui =
    configuredTuiMode === "fullscreen"
      ? new VspiTuiAltScreen(terminal, true, undefined, { openUrl: openTerminalUrl })
      : new ScrollbackTUI(terminal, true);
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
  const goalBackend = createStartupGoalBackend({
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
      deepSeekHarness: deepSeekHarnessEnabled(),
      ...(security.workflowAdapter ? { workflowPlan: workflowAdapter } : {}),
    },
    goalBackend,
  );
  const attachments = new AttachmentService(randomUUID(), theme);
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
    stopParentWatchdog();
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
  const stopParentWatchdog = startParentDeathWatchdog(() => void shutdown());

  tui.addChild(app);
  tui.setFocus(app);
  terminal.setTitle("VSPi");
  try {
    await startUiAfterSplash({
      width: terminal.columns,
      theme,
      write: (chunk) => terminal.write(chunk),
      startApp: async () => {
        await app.start();
        return app.startupStatus();
      },
      startTui: async (startupSurface) => {
        app.setStartupSurface(startupSurface);
        app.getActiveTui().start();
        if (sessionMode.initialCommand) await app.runStartupCommand(sessionMode.initialCommand);
      },
    });
  } catch (error) {
    await shutdown();
    throw error;
  }
}

/** 启动会话语义：默认新会话；`vspi continue`（或 `-c`/`--continue`）续接最近会话；`vspi resume`（或 `-r`/`--resume`）打开会话选择器。 */
function startupSessionMode(): {
  continueRecent: boolean;
  openOnStart?: "sessions" | "providers";
  initialCommand?: string;
} {
  const argv = process.argv.slice(2);
  // -c/--continue、-r/--resume 是与常见 CLI 对齐的兼容别名（入口分发同样识别）。
  const entryAlias =
    argv[0] === "-c" || argv[0] === "--continue"
      ? "continue"
      : argv[0] === "-r" || argv[0] === "--resume"
        ? "resume"
        : argv[0];
  return {
    continueRecent: entryAlias === "continue",
    ...(entryAlias === "resume" ? { openOnStart: "sessions" as const } : {}),
    ...(argv[0] === "config" || argv[0] === "init" ? { openOnStart: "providers" as const } : {}),
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
  process.stdout.write(`vspi ${VSPI_VERSION} - VSPi 中文 TUI AI 编程助手

用法：
  vspi                     启动新会话（交互 TUI）
  vspi config [custom]     配置 Provider、账号与 API Key
  vspi init [custom]       兼容旧入口；请迁移到 vspi config
  vspi login [provider]    登录订阅账号或保存 API Key
  vspi logout [provider]   移除 Pi 保存的 Provider 凭据
  vspi continue            续接最近的会话（兼容 -c / --continue）
  vspi resume              启动后进入会话选择器（兼容 -r / --resume）
  vspi import [codex|claude]
                            导入外部 Agent 的历史会话
  vspi skills               管理、安装与导入 Skill
  vspi exec "<prompt>"     非交互执行单个 prompt，结果输出到 stdout
  vspi exec resume "<prompt>"
                            续接最近会话非交互执行
  vspi exec resume <id> "<prompt>"
                            续接指定会话非交互执行（id 支持唯一前缀）
  vspi run "<prompt>"      兼容别名：等价 vspi exec "<prompt>"
  vspi update              检查并安装最新稳定版本

选项：
  --policy <level>         Safe | Standard | YOLO | Auto（只控制审批强度）
  --trust-project          信任当前项目（读取 .vspi/ 配置与 Provider overlay）
  --workflow               启用只读 Workflow Plan 投影（默认关闭）
  --recovery               恢复模式：强制 Standard ⋅ Host，禁用项目资源与 Workflow
  --render-once            渲染一帧后退出（smoke 用）
  -h, --help               显示本帮助
  -v, --version            显示版本号

退出码（exec）：0 成功；1 运行失败；2 用法错误；130 已取消。

环境变量：
  VSPi_BACKEND=pi|fixture  选择后端（fixture 等价 VSPi_FIXTURE=1，完全离线）
  VSPI_DEEPSEEK_HARNESS=0  关闭默认启用的 DeepSeek V4 anchored-standard
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

const rawEntry = process.argv[2];
// -c/--continue 与 -r/--resume 归一为对应子命令后再分发。
const entry =
  rawEntry === "-c" || rawEntry === "--continue"
    ? "continue"
    : rawEntry === "-r" || rawEntry === "--resume"
      ? "resume"
      : rawEntry;
if (entry === "run" || entry === "exec") await runExec(process.argv.slice(3));
else if (entry === "update") await selfUpdate();
else if (entry === "config" || entry === "init" || entry === "login" || entry === "logout") {
  if (entry === "init") process.stderr.write("vspi init 已更名为 vspi config；本次继续执行配置。\n");
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
