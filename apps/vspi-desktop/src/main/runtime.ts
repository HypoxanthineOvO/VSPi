import type { Klient } from "@moonshot-ai/klient";
import { z } from "zod";

export const discoverySchema = z.object({
  desktopProtocol: z.literal(1),
  protocolVersion: z.literal(1),
  runtimeId: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string(),
  homeDir: z.string(),
  ipcPath: z
    .string()
    .startsWith("/")
    .refine((value) => !/[:\r\n\0]/.test(value)),
  httpPort: z.number().int().min(1).max(65535),
  token: z.string().min(1),
});
export type DiscoveryMetadata = z.infer<typeof discoverySchema>;

export interface RuntimeInfo {
  kind: "local" | "ssh";
  runtimeId: string;
  version: string;
  homeDir: string;
  host: string;
  label: string;
}
export interface Runtime {
  klient: Klient;
  info: RuntimeInfo;
  request(path: string, body?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export const REQUIRED_CAPABILITIES = [
  "klient-tunnel-v1",
  "history-snapshot-v1",
  "prompt-id-v1",
] as const;

export function assertCompatibleHandshake(
  handshake: unknown,
  metadata: DiscoveryMetadata,
): void {
  const data =
    handshake !== null && typeof handshake === "object"
      ? (handshake as Record<string, unknown>)
      : {};
  if (
    data["runtimeId"] !== metadata.runtimeId ||
    data["desktopProtocol"] !== 1 ||
    data["protocolVersion"] !== metadata.protocolVersion ||
    data["version"] !== metadata.version ||
    !Array.isArray(data["capabilities"]) ||
    !REQUIRED_CAPABILITIES.every((cap) =>
      (data["capabilities"] as unknown[]).includes(cap),
    )
  ) {
    throw new Error(
      "运行时协议不兼容：需要包含 klient-tunnel-v1、history-snapshot-v1、prompt-id-v1 能力的 VSPi 构建。",
    );
  }
}

export function parseDiscoveryLine(
  line: string,
): DiscoveryMetadata | undefined {
  try {
    return discoverySchema.parse(JSON.parse(line));
  } catch {
    return undefined;
  }
}

export async function runtimeRequest(
  httpPort: number,
  token: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${httpPort}/api/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await response.json()) as {
    code: number;
    data?: unknown;
    msg?: string;
  };
  if (!response.ok || data.code !== 0)
    throw new Error(data.msg ?? "远端文件操作失败");
  return data.data;
}
