import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { connectKlientSocket } from "@moonshot-ai/klient/ipc";
import type { Klient } from "@moonshot-ai/klient";
import { z } from "zod";
import {
  assertCompatibleHandshake,
  discoverySchema,
  runtimeRequest,
  type DiscoveryMetadata,
  type Runtime,
} from "./runtime.js";

export const localOptionsSchema = z
  .object({
    executable: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !/[\r\n\0]/.test(value)),
    executableArgs: z
      .array(z.string().max(4096))
      .max(8)
      .refine((args) => args.every((value) => !/[\r\n\0]/.test(value)))
      .default([]),
    homeDir: z
      .string()
      .max(4096)
      .refine((value) => !/[\r\n\0]/.test(value))
      .optional(),
    label: z.string().max(256).default("本机"),
  })
  .strict();
export type LocalOptions = z.input<typeof localOptionsSchema>;

export const unsupportedDesktopMessage =
  "本机 VSPi 不支持 Desktop 协议，需要包含 `vspi daemon desktop` 的构建。请在 设置 → 连接 中指定可执行文件。";

export function localStartupError(
  output: string,
  executable: string,
): Error {
  if (output.includes("Usage:")) return new Error(unsupportedDesktopMessage);
  const detail = output.trim().split("\n").slice(0, 6).join("\n").slice(0, 600);
  if (!detail)
    return new Error(`无法启动本机 VSPi 可执行文件：${executable}`);
  if (/(incompatib|mismatch|protocol|version|runtime|daemon|lock|running)/i.test(detail))
    return new Error(`${detail}。可在设置中改用独立数据目录`);
  return new Error(detail);
}

export async function connectLocal(
  input: LocalOptions,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  progress: (message: string) => void,
  disconnected: () => void,
): Promise<Runtime> {
  const options = localOptionsSchema.parse(input);
  let klient: Klient | undefined;
  let closed = false;
  let ready = false;
  let child: ChildProcessWithoutNullStreams | undefined;
  const close = async () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abort);
    await klient?.close().catch(() => undefined);
    if (child) {
      child.stdin.end();
      child.kill();
    }
  };
  const abort = () => {
    void close();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    progress("正在启动本机 VSPi 运行时…");
    signal.throwIfAborted();
    const args = [...options.executableArgs, "daemon", "desktop"];
    if (options.homeDir) args.push("--home-dir", options.homeDir);
    child = spawn(options.executable, args, {
      env,
      stdio: "pipe",
      windowsHide: true,
    });
    const process_ = child;
    process_.stderr.resume();
    process_.on("error", () => {
      if (ready && !closed) {
        disconnected();
        void close();
      }
    });
    process_.on("exit", () => {
      if (ready && !closed) {
        disconnected();
        void close();
      }
    });
    const metadata = await new Promise<DiscoveryMetadata>((resolve, reject) => {
      let buffer = "";
      let output = "";
      const timer = setTimeout(() => {
        finish(new Error("本机运行时发现超时，请检查 VSPi 可执行文件与数据目录"));
      }, 120_000);
      const onAbort = () => {
        finish(new Error("连接已取消"));
      };
      const onExit = () => {
        finish(localStartupError(output, options.executable));
      };
      const onError = () => {
        finish(
          new Error(`无法启动本机 VSPi 可执行文件：${options.executable}`),
        );
      };
      const collect = (chunk: Buffer, stream: "out" | "err") => {
        output += chunk.toString("utf8");
        if (output.length > 256 * 1024) output = output.slice(-256 * 1024);
        if (stream !== "out") return;
        buffer += chunk.toString("utf8");
        if (buffer.length > 64 * 1024) {
          finish(new Error("本机发现响应超出限制"));
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
          finish(new Error(unsupportedDesktopMessage));
        }
      };
      const onStdout = (chunk: Buffer) => collect(chunk, "out");
      const onStderr = (chunk: Buffer) => collect(chunk, "err");
      function finish(error?: Error, value?: DiscoveryMetadata) {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        process_.removeListener("exit", onExit);
        process_.removeListener("error", onError);
        process_.stdout.removeListener("data", onStdout);
        process_.stderr.removeListener("data", onStderr);
        process_.stdout.resume();
        process_.stderr.resume();
        if (error) reject(error);
        else resolve(value!);
      }
      process_.stdout.on("data", onStdout);
      process_.stderr.on("data", onStderr);
      process_.once("exit", onExit);
      process_.once("error", onError);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    progress("正在连接本机运行时…");
    const connection = await connectKlientSocket({
      socketPath: metadata.ipcPath,
      token: metadata.token,
      handshakeTimeoutMs: 15_000,
    });
    try {
      assertCompatibleHandshake(connection.handshake, metadata);
    } catch (error) {
      await connection.klient.close();
      throw error;
    }
    klient = connection.klient;
    signal.throwIfAborted();
    if (closed) throw new Error("连接已取消");
    ready = true;
    signal.removeEventListener("abort", abort);
    progress("已连接");
    return {
      klient,
      info: {
        kind: "local",
        runtimeId: metadata.runtimeId,
        version: metadata.version,
        homeDir: metadata.homeDir,
        host: "localhost",
        label: options.label,
      },
      close,
      request: async (path, body) => {
        if (closed) throw new Error("本机连接已断开");
        return runtimeRequest(metadata.httpPort, metadata.token, path, body);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
