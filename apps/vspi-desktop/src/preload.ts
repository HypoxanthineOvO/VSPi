import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, DesktopEvent } from "./shared.js";
const api: DesktopApi = {
  call: async (method, input) => {
    const result = await ipcRenderer.invoke("desktop:call", method, input);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, data: DesktopEvent) => {
      listener(data);
    };
    ipcRenderer.on("desktop:event", handler);
    return () => ipcRenderer.removeListener("desktop:event", handler);
  },
};
contextBridge.exposeInMainWorld("desktop", api);
