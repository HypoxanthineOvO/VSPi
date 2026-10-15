import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connectKlient } from "@moonshot-ai/klient/tcp";
import type { Klient } from "@moonshot-ai/klient";
import { z } from "zod";
import {
  assertCompatibleHandshake,
  discoverySchema,
  runtimeRequest,
  type Runtime,
} from "./runtime.js";

export const sshOptionsSchema = z
  .object({
    host: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:@%-]*$/)
      .max(255),
    port: z.number().int().min(1).max(65535).optional(),
    executable: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !/[\r\n\0]/.test(value))
      .default("vspi"),
    homeDir: z
      .string()
      .max(4096)
      .refine((value) => !/[\r\n\0]/.test(value))
      .optional(),
    label: z.string().max(256).optional(),
  })
  .strict();
export type SshOptions = z.input<typeof sshOptionsSchema>;
export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function sshArguments(options: SshOptions): string[] {
  const parsed = sshOptionsSchema.parse(options);
  const args = [
    "-T",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StrictHostKeyChecking=ask",
  ];
  if (parsed.port !== undefined) args.push("-p", String(parsed.port));
  return args;
}
export async function sshAliases(): Promise<string[]> {
  try {
    const config = await readFile(join(homedir(), ".ssh", "config"), "utf8");
    return [
      ...new Set(
        config.split("\n").flatMap((line) => {
          const match = /^\s*Host\s+(.+)$/i.exec(line);
          return match
            ? match[1]!
                .split(/\s+/)
                .filter((host) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host))
            : [];
        }),
      ),
    ];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (!address || typeof address === "string")
    throw new Error("无法分配本机转发端口");
  return address.port;
}
export async function connectSsh(
  input: SshOptions,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  progress: (message: string) => void,
  disconnected: () => void,
): Promise<Runtime> {
  const options = sshOptionsSchema.parse(input);
  const children: ChildProcessWithoutNullStreams[] = [];
  let klient: Klient | undefined;
  let closed = false;
  let ready = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abort);
    await klient?.close().catch(() => undefined);
    for (const child of children) {
      child.stdin.end();
      child.kill();
    }
  };
  const abort = () => {
    void close();
  };
  signal.addEventListener("abort", abort, { once: true });
  const launch = (args: string[]) => {
    signal.throwIfAborted();
    if (closed) throw new Error("连接已取消");
    const child = spawn("ssh", args, { env, stdio: "pipe", windowsHide: true });
    children.push(child);
    child.stderr.resume();
    child.on("error", () => {
      if (ready && !closed) {
        disconnected();
        void close();
      }
    });
    child.on("exit", () => {
      if (ready && !closed) {
        disconnected();
        void close();
      }
    });
    return child;
  };
  try {
    progress("正在校验 SSH 主机并连接远端运行时…");
    const command = `${quoteShell(options.executable)} daemon desktop${options.homeDir ? ` --home-dir ${quoteShell(options.homeDir)}` : ""}`;
    const discovery = launch([...sshArguments(options), options.host, command]);
    const metadata = await new Promise<z.infer<typeof discoverySchema>>(
      (resolve, reject) => {
        let buffer = "";
        const timer = setTimeout(() => {
          finish(new Error("远端运行时发现超时，请检查 SSH 和 VSPi 安装路径"));
        }, 120_000);
        const onAbort = () => {
          finish(new Error("连接已取消"));
        };
        const onExit = () => {
          finish(
            new Error(
              "SSH 已退出。请检查主机认证、远端 VSPi 路径及运行时版本；现有任务不会被自动重启。",
            ),
          );
        };
        const onError = () => {
          finish(new Error("无法启动系统 OpenSSH，请安装 ssh 并确认 PATH"));
        };
        const onData = (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          if (buffer.length > 64 * 1024) {
            finish(new Error("远端发现响应超出限制"));
            return;
          }
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          try {
            const parsed = discoverySchema.parse(
              JSON.parse(buffer.slice(0, newline)),
            );
            finish(undefined, parsed);
          } catch {
            finish(
              new Error(
                "远端不支持 Desktop 协议，或 SSH 启动脚本向标准输出写入了额外内容",
              ),
            );
          }
        };
        function finish(
          error?: Error,
          value?: z.infer<typeof discoverySchema>,
        ) {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          discovery.removeListener("exit", onExit);
          discovery.removeListener("error", onError);
          discovery.stdout.removeListener("data", onData);
          discovery.stdout.resume();
          if (error) reject(error);
          else resolve(value!);
        }
        discovery.stdout.on("data", onData);
        discovery.once("exit", onExit);
        discovery.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      },
    );
    progress("正在建立加密通道…");
    const ipcPort = await availablePort();
    const httpPort = await availablePort();
    const tunnel = launch([
      ...sshArguments(options),
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `127.0.0.1:${ipcPort}:${metadata.ipcPath}`,
      "-L",
      `127.0.0.1:${httpPort}:127.0.0.1:${metadata.httpPort}`,
      options.host,
    ]);
    tunnel.stdout.resume();
    for (let attempt = 0; attempt < 600; attempt++) {
      signal.throwIfAborted();
      if (closed || tunnel.exitCode !== null || discovery.exitCode !== null)
        throw new Error("SSH 通道已断开");
      try {
        const connection = await connectKlient({
          port: ipcPort,
          token: metadata.token,
          handshakeTimeoutMs: 1500,
        });
        try {
          assertCompatibleHandshake(connection.handshake, metadata);
        } catch (error) {
          await connection.klient.close();
          throw error;
        }
        klient = connection.klient;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED")
          throw error;
        await new Promise((resolve) => {
          setTimeout(resolve, 200);
        });
      }
    }
    if (!klient) throw new Error("建立 SSH 转发超时");
    signal.throwIfAborted();
    if (closed) throw new Error("连接已取消");
    ready = true;
    signal.removeEventListener("abort", abort);
    progress("已连接");
    return {
      klient,
      info: {
        kind: "ssh",
        runtimeId: metadata.runtimeId,
        version: metadata.version,
        homeDir: metadata.homeDir,
        host: options.host,
        label: options.label ?? options.host,
      },
      close,
      request: async (path, body) => {
        if (closed) throw new Error("远端连接已断开");
        return runtimeRequest(httpPort, metadata.token, path, body);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
