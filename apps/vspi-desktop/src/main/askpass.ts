import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsAskpassSource } from "./windows-askpass.js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteShell } from "./ssh.js";
import type { DesktopEvent } from "../shared.js";
export async function createAskpass(
  executable: string,
  client: string,
  emit: (event: DesktopEvent) => void,
  platform: NodeJS.Platform = process.platform,
) {
  const token = randomBytes(32).toString("hex");
  const pending = new Map<string, (answer: string | null) => void>();
  const server = createServer((req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      req.method !== "POST" ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      res.writeHead(403).end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > 16_384) req.destroy();
    });
    req.on("end", () => {
      let prompt: string;
      try {
        const data = JSON.parse(body) as { prompt: unknown };
        if (typeof data.prompt !== "string")
          throw new Error("Invalid response");
        prompt = data.prompt;
      } catch {
        res.writeHead(400).end();
        return;
      }
      const id = randomUUID();
      const finish = (answer: string | null) => {
        clearTimeout(timer);
        pending.delete(id);
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ answer }));
      };
      const timer = setTimeout(() => {
        finish(null);
      }, 110_000);
      res.on("close", () => {
        clearTimeout(timer);
        pending.delete(id);
      });
      pending.set(id, finish);
      emit({
        type: "auth",
        id,
        prompt,
        confirm: /yes\/no|fingerprint/i.test(prompt),
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("无法启动 SSH 认证入口");
  const dir = await mkdtemp(join(tmpdir(), "vspi-desktop-askpass-"));
  const windows = platform === "win32";
  const path = join(dir, windows ? "askpass.exe" : "askpass.sh");
  try {
    if (windows) {
      await promisify(execFile)(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Add-Type -TypeDefinition $env:VSPI_ASKPASS_SOURCE -OutputAssembly $env:VSPI_ASKPASS_TARGET -OutputType ConsoleApplication",
        ],
        {
          env: {
            ...process.env,
            VSPI_ASKPASS_SOURCE: windowsAskpassSource,
            VSPI_ASKPASS_TARGET: path,
          },
          timeout: 30000,
          windowsHide: true,
        },
      );
    } else {
      await writeFile(
        path,
        `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quoteShell(executable)} ${quoteShell(client)} "$@"\n`,
        { mode: 0o700 },
      );
    }
  } catch {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await rm(dir, { recursive: true, force: true });
    throw new Error(
      "无法准备 SSH 认证组件，请检查 Windows PowerShell 是否可用。",
    );
  }
  return {
    env: {
      ...process.env,
      SSH_ASKPASS: path,
      VSPI_ASKPASS_ELECTRON: executable,
      VSPI_ASKPASS_CLIENT: client,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: process.env["DISPLAY"] ?? ":0",
      VSPI_ASKPASS_PORT: String(address.port),
      VSPI_ASKPASS_TOKEN: token,
    },
    answer(id: string, answer: string | null) {
      pending.get(id)?.(answer);
    },
    async close() {
      for (const finish of pending.values()) finish(null);
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await rm(dir, { recursive: true, force: true });
    },
  };
}
