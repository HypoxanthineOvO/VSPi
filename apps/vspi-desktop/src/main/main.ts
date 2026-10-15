// oxlint-disable eslint-plugin-unicorn/prefer-top-level-await -- Electron entrypoints are bundled as CommonJS.
import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { DesktopController } from "./controller.js";
import { desktopEnabled } from "./feature.js";
import { createAskpass } from "./askpass.js";
import type { DesktopEvent } from "../shared.js";
app.setName("VSPi Desktop");
let controller: DesktopController | undefined;
let askpass: Awaited<ReturnType<typeof createAskpass>> | undefined;
let quitting = false;
async function start() {
  if (!desktopEnabled(process.env)) {
    dialog.showErrorBox(
      "VSPi Desktop",
      "启动前请设置 KIMI_CODE_EXPERIMENTAL_DESKTOP=1。",
    );
    app.quit();
    return;
  }
  const page = pathToFileURL(join(__dirname, "renderer/index.html")).href;
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 620,
    title: "VSPi Desktop",
    backgroundColor: "#111316",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.removeMenu();
  const emit = (event: DesktopEvent) => {
    if (!window.isDestroyed()) window.webContents.send("desktop:event", event);
  };
  askpass = await createAskpass(
    process.execPath,
    join(__dirname, "askpass-client.cjs"),
    emit,
  );
  controller = new DesktopController(askpass.env, emit, {
    hostsPath: join(app.getPath("userData"), "hosts.json"),
    appPath: app.getAppPath(),
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => {
      callback(false);
    },
  );
  ipcMain.handle(
    "desktop:call",
    async (event, method: unknown, input: unknown) => {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== page
      )
        return { ok: false, error: "无效的桌面调用来源" };
      try {
        if (typeof method !== "string") throw new Error("无效操作");
        if (method === "authAnswer") {
          const data = z
            .object({ id: z.string(), answer: z.string().max(4096).nullable() })
            .parse(input);
          askpass!.answer(data.id, data.answer);
          return { ok: true };
        }
        return { ok: true, value: await controller!.call(method, input) };
      } catch (error) {
        const sensitive =
          method === "saveProvider" || method === "testProvider";
        const message =
          error instanceof z.ZodError
            ? "输入格式无效，请检查字段。"
            : error instanceof Error
              ? error.message
              : "操作失败";
        return {
          ok: false,
          error: /configuration changed/i.test(message)
            ? "远端配置已被修改，请重新读取后再保存。"
            : sensitive &&
                !/revision|conflict|configuration changed|冲突/i.test(message)
              ? "远端设置操作失败，请检查配置字段、凭据和网络。"
              : message.slice(0, 1000),
        };
      }
    },
  );
  await window.loadURL(page);
}
app.on("window-all-closed", () => {
  app.quit();
});
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void Promise.allSettled([controller?.disconnect(), askpass?.close()]).finally(
    () => {
      app.quit();
    },
  );
});
void app
  .whenReady()
  .then(start)
  .catch((error: unknown) => {
    dialog.showErrorBox(
      "VSPi Desktop",
      error instanceof Error ? error.message : "桌面启动失败",
    );
    app.quit();
  });
