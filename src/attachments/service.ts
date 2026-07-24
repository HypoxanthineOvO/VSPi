import { Image } from "@earendil-works/pi-tui";
import type { Attachment } from "../domain/types.js";
import type { TerminalCapabilities } from "../ui/capabilities.js";
import type { VspiTheme } from "../ui/theme.js";
import { AttachmentBridge } from "./bridge.js";
import { readClipboardImage } from "./clipboard.js";
import { AttachmentStore, type AttachmentStoreOptions } from "./store.js";

export interface AttachmentServiceEvents {
  onAttachment: (attachment: Attachment, ownership?: AttachmentSessionOwnership) => void | Promise<void>;
  onNotice: (text: string, tone: "info" | "success" | "warning" | "error") => void;
}

export interface AttachmentSessionOwnership {
  sessionId: string;
  generation: number;
}

export class AttachmentService {
  store: AttachmentStore;
  private bridge: AttachmentBridge | undefined;
  private events: AttachmentServiceEvents | undefined;
  private bridgeEnabled = false;
  private readonly storeOptions: AttachmentStoreOptions;
  private started = false;
  private operation: Promise<void> = Promise.resolve();
  private generation = 0;

  get sessionGeneration(): number {
    return this.generation;
  }

  constructor(
    sessionId: string,
    private readonly capabilities: TerminalCapabilities,
    private readonly theme: VspiTheme,
    options: { home?: string; maxBytes?: number } = {},
  ) {
    this.storeOptions = { ...options };
    this.store = new AttachmentStore(sessionId, this.storeOptions);
  }

  async start(events: AttachmentServiceEvents, bridgeEnabled: boolean): Promise<void> {
    this.events = events;
    this.bridgeEnabled = bridgeEnabled;
    this.started = true;
    const store = this.store;
    const ownership = this.ownership();
    await this.enqueue(async () => {
      await store.initialize();
      if (!this.isCurrent(store, ownership)) return;
      if (this.capabilities.ssh && bridgeEnabled) await this.startBridge();
    });
  }

  async switchSession(sessionId: string): Promise<void> {
    const next = new AttachmentStore(sessionId, this.storeOptions);
    const generation = ++this.generation;
    const stopping = this.bridge?.stop();
    this.bridge = undefined;
    await this.enqueue(async () => {
      await stopping;
      if (generation !== this.generation) return;
      if (sessionId === this.store.sessionId) {
        await this.store.initialize();
        if (this.started && this.capabilities.ssh && this.bridgeEnabled && this.events) await this.startBridge();
        return;
      }
      await next.initialize();
      if (generation !== this.generation) return;
      this.store = next;
      if (this.started && this.capabilities.ssh && this.bridgeEnabled && this.events) await this.startBridge();
    });
  }

  async pasteLocal(): Promise<Attachment | undefined> {
    const ownership = this.ownership();
    const store = this.store;
    const image = await readClipboardImage();
    if (!image) {
      this.events?.onNotice(
        this.capabilities.ssh ? "远程终端请使用 Attachment Bridge" : "剪贴板中没有可读取的图片",
        "warning",
      );
      return undefined;
    }
    return this.enqueue(async () => {
      if (!this.isCurrent(store, ownership)) return undefined;
      const attachment = await store.add(image.bytes, image.mimeType);
      if (!this.isCurrent(store, ownership)) {
        await store.remove(attachment.id);
        return undefined;
      }
      try {
        await this.events?.onAttachment(attachment, ownership);
      } catch {
        await store.remove(attachment.id);
        throw new Error("附件无法送达编辑器");
      }
      if (!this.isCurrent(store, ownership)) {
        await store.remove(attachment.id);
        return undefined;
      }
      return attachment;
    });
  }

  async rename(id: string, alias: string): Promise<Attachment> {
    const ownership = this.ownership();
    const store = this.store;
    return this.enqueue(async () => {
      this.assertCurrent(store, ownership);
      const attachment = await store.rename(id, alias);
      this.assertCurrent(store, ownership);
      return attachment;
    });
  }

  async remove(id: string): Promise<void> {
    const ownership = this.ownership();
    const store = this.store;
    await this.enqueue(async () => {
      this.assertCurrent(store, ownership);
      await store.remove(id);
      this.assertCurrent(store, ownership);
    });
  }

  async saveToProject(id: string, cwd: string): Promise<string> {
    const ownership = this.ownership();
    const store = this.store;
    return this.enqueue(async () => {
      this.assertCurrent(store, ownership);
      const path = await store.saveToProject(id, cwd);
      this.assertCurrent(store, ownership);
      return path;
    });
  }

  async preview(id: string): Promise<Image> {
    const ownership = this.ownership();
    const store = this.store;
    return this.enqueue(async () => {
      this.assertCurrent(store, ownership);
      const attachment = store.get(id);
      if (!attachment) throw new Error("附件不存在");
      const base64 = await store.readBase64(id);
      this.assertCurrent(store, ownership);
      return new Image(
        base64,
        attachment.mimeType,
        { fallbackColor: this.theme.muted },
        {
          filename: attachment.alias,
          maxWidthCells: 64,
          maxHeightCells: 12,
        },
      );
    });
  }

  async dispose(): Promise<void> {
    this.started = false;
    this.generation += 1;
    const stopping = this.bridge?.stop();
    this.bridge = undefined;
    await this.enqueue(async () => {
      await stopping;
      this.events = undefined;
    });
  }

  private async startBridge(): Promise<void> {
    const events = this.events;
    if (!events) return;
    const store = this.store;
    const ownership = this.ownership();
    const bridge = this.createBridge(store, ownership);
    this.bridge = bridge;
    try {
      await bridge.start();
      if (!this.isCurrent(store, ownership)) {
        await bridge.stop();
        if (this.bridge === bridge) this.bridge = undefined;
        return;
      }
      events.onNotice(`SSH Bridge ${bridge.url}`, "info");
    } catch (error) {
      if (!this.isCurrent(store, ownership)) {
        this.bridge = undefined;
        return;
      }
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        const fallback = this.createBridge(store, ownership, 0);
        this.bridge = fallback;
        try {
          await fallback.start();
          if (!this.isCurrent(store, ownership)) {
            await fallback.stop();
            if (this.bridge === fallback) this.bridge = undefined;
            return;
          }
          events.onNotice(`默认端口占用，SSH Bridge ${fallback.url}`, "warning");
          return;
        } catch {
          // Fall through to the generic, non-sensitive error below.
        }
      }
      this.bridge = undefined;
      events.onNotice("SSH Bridge 启动失败", "error");
    }
  }

  private createBridge(store: AttachmentStore, ownership: AttachmentSessionOwnership, port?: number): AttachmentBridge {
    return new AttachmentBridge(store, {
      ...(port === undefined ? {} : { port }),
      onAttachment: async (attachment) => {
        if (!this.isCurrent(store, ownership)) {
          await store.remove(attachment.id);
          throw staleAttachmentError();
        }
        await this.events?.onAttachment(attachment, ownership);
        if (!this.isCurrent(store, ownership)) {
          await store.remove(attachment.id);
          throw staleAttachmentError();
        }
      },
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private ownership(): AttachmentSessionOwnership {
    return { sessionId: this.store.sessionId, generation: this.generation };
  }

  private isCurrent(store: AttachmentStore, ownership: AttachmentSessionOwnership): boolean {
    return (
      this.started &&
      this.store === store &&
      this.store.sessionId === ownership.sessionId &&
      this.generation === ownership.generation
    );
  }

  private assertCurrent(store: AttachmentStore, ownership: AttachmentSessionOwnership): void {
    if (!this.isCurrent(store, ownership)) throw staleAttachmentError();
  }
}

function staleAttachmentError(): Error {
  const error = new Error("附件操作因会话切换而取消");
  error.name = "AbortError";
  return error;
}
