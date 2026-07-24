import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Attachment } from "../domain/types.js";
import type { AttachmentStore } from "./store.js";

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VSPi Attachment Bridge</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#111315;color:#E8EAED;font:16px ui-monospace,SFMono-Regular,Consolas,monospace;min-height:100vh;display:grid;place-items:center}
main{width:min(560px,calc(100vw - 32px));border-top:2px solid #5FC7C7;padding:24px 0}h1{font-size:20px;margin:0 0 12px;color:#5FC7C7}p{margin:0;color:#92989F}.ok{color:#7CCB8A}.error{color:#F07878}
</style></head><body><main><h1>VSPi Attachment Bridge</h1><p id="status">等待图片</p></main><script>
const status=document.querySelector('#status');const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
addEventListener('paste',async event=>{const file=[...event.clipboardData.items].find(item=>item.type.startsWith('image/'))?.getAsFile();if(!file){status.textContent='剪贴板中没有图片';status.className='error';return}status.textContent='上传中';status.className='';try{const response=await fetch('/attachment',{method:'POST',headers:{'content-type':file.type,'x-vspi-token':token},body:file});const result=await response.json();if(!response.ok)throw new Error(result.error||'上传失败');status.textContent=result.alias;status.className='ok'}catch(error){status.textContent=error.message;status.className='error'}});
</script></body></html>`;

export interface AttachmentBridgeOptions {
  port?: number;
  maxBytes?: number;
  token?: string;
  onAttachment?: (attachment: Attachment) => void | Promise<void>;
}

export class AttachmentBridge {
  readonly token: string;
  readonly maxBytes: number;
  private server: Server | undefined;
  private activePort = 0;
  private requestTimes: number[] = [];

  constructor(
    private readonly store: AttachmentStore,
    private readonly options: AttachmentBridgeOptions = {},
  ) {
    this.token = options.token ?? randomBytes(24).toString("base64url");
    if (Buffer.byteLength(this.token) < 24) throw new Error("Attachment bridge token is too short");
    this.maxBytes = options.maxBytes ?? store.maxBytes;
  }

  get port(): number {
    return this.activePort;
  }

  get url(): string {
    if (!this.activePort) throw new Error("Attachment bridge is not listening");
    return `http://localhost:${this.activePort}/#${this.token}`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => void this.handle(request, response));
    try {
      await new Promise<void>((resolve, reject) => {
        this.server?.once("error", reject);
        this.server?.listen(this.options.port ?? 43117, "127.0.0.1", () => {
          this.server?.off("error", reject);
          const address = this.server?.address();
          this.activePort = typeof address === "object" && address ? address.port : 0;
          resolve();
        });
      });
    } catch (error) {
      this.server = undefined;
      this.activePort = 0;
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.activePort = 0;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
        response.end(PAGE);
        return;
      }
      if (request.method !== "POST" || request.url !== "/attachment")
        return this.json(response, 404, { error: "Not found" });
      if (!this.withinRateLimit()) return this.json(response, 429, { error: "Too many requests" });
      if (!this.authorized(request.headers["x-vspi-token"])) return this.json(response, 401, { error: "Unauthorized" });
      if (!this.validOrigin(request.headers.origin)) return this.json(response, 403, { error: "Invalid origin" });
      const mimeType = request.headers["content-type"] ?? "";
      if (!/^image\/(?:png|jpeg|webp|gif)(?:;|$)/i.test(mimeType))
        return this.json(response, 415, { error: "Unsupported image" });
      const bytes = await this.readBody(request);
      const attachment = await this.store.add(bytes, mimeType);
      try {
        await this.options.onAttachment?.(attachment);
      } catch (error) {
        await this.store.remove(attachment.id);
        throw error;
      }
      this.json(response, 201, { id: attachment.id, alias: attachment.alias });
    } catch (error) {
      this.json(response, 400, { error: publicUploadError(error) });
    }
  }

  private validOrigin(origin: string | undefined): boolean {
    if (!origin) return false;
    return origin === `http://localhost:${this.activePort}` || origin === `http://127.0.0.1:${this.activePort}`;
  }

  private authorized(value: string | string[] | undefined): boolean {
    if (typeof value !== "string") return false;
    const expected = Buffer.from(this.token);
    const supplied = Buffer.from(value);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }

  private withinRateLimit(): boolean {
    const cutoff = Date.now() - 60_000;
    this.requestTimes = this.requestTimes.filter((timestamp) => timestamp >= cutoff);
    if (this.requestTimes.length >= 30) return false;
    this.requestTimes.push(Date.now());
    return true;
  }

  private async readBody(request: IncomingMessage): Promise<Uint8Array> {
    const declared = Number(request.headers["content-length"] ?? 0);
    if (declared > this.maxBytes) throw new Error("Image is too large");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > this.maxBytes) {
        request.destroy();
        throw new Error("Image is too large");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  private json(response: ServerResponse, status: number, body: Record<string, unknown>): void {
    if (response.headersSent) return;
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    response.end(JSON.stringify(body));
  }
}

function publicUploadError(error: unknown): string {
  if (!(error instanceof Error)) return "Invalid upload";
  const allowed = ["仅支持", "图片内容为空", "图片超过", "图片内容与 MIME", "无法读取图片尺寸", "Image is too large"];
  return allowed.some((prefix) => error.message.startsWith(prefix)) ? error.message : "Invalid upload";
}
