import { Image } from "@moonshot-ai/pi-tui";
import type { Attachment } from "../domain/types.js";
import type { VspiTheme } from "../ui/theme.js";
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
  private events: AttachmentServiceEvents | undefined;
  private readonly storeOptions: AttachmentStoreOptions;
  private started = false;
  private operation: Promise<void> = Promise.resolve();
  private generation = 0;

  get sessionGeneration(): number {
    return this.generation;
  }

  constructor(
    sessionId: string,
    private readonly theme: VspiTheme,
    options: { home?: string; maxBytes?: number } = {},
  ) {
    this.storeOptions = { ...options };
    this.store = new AttachmentStore(sessionId, this.storeOptions);
  }

  async start(events: AttachmentServiceEvents): Promise<void> {
    this.events = events;
    this.started = true;
    const store = this.store;
    const ownership = this.ownership();
    await this.enqueue(async () => {
      await store.initialize();
      if (!this.isCurrent(store, ownership)) return;
    });
  }

  async switchSession(sessionId: string): Promise<void> {
    const next = new AttachmentStore(sessionId, this.storeOptions);
    const generation = ++this.generation;
    await this.enqueue(async () => {
      if (generation !== this.generation) return;
      if (sessionId === this.store.sessionId) {
        await this.store.initialize();
        return;
      }
      await next.initialize();
      if (generation !== this.generation) return;
      this.store = next;
    });
  }

  async pasteLocal(): Promise<Attachment | undefined> {
    const ownership = this.ownership();
    const store = this.store;
    const image = await readClipboardImage();
    if (!image) {
      this.events?.onNotice("剪贴板中没有可读取的图片", "warning");
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
    await this.enqueue(async () => {
      this.events = undefined;
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
