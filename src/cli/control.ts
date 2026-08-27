import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SESSION_CONTROL_VERSION, SessionControlClient, type SessionControlDescriptor } from "../sessions/control.js";

type ControlCommand = "status" | "snapshot" | "send" | "wait" | "watch";

export async function runControl(argv: string[]): Promise<void> {
  try {
    const command = argv[0] as ControlCommand | undefined;
    if (!command || !["status", "snapshot", "send", "wait", "watch"].includes(command)) {
      throw new Error(controlUsage());
    }
    const rest = argv.slice(1);
    const { selector, value, idempotencyKey } = parseControlArguments(command, rest);
    const candidates = await resolveDescriptors(selector);
    let client: SessionControlClient | undefined;
    let connectionError: unknown;
    for (const descriptor of candidates) {
      try {
        client = await SessionControlClient.connect(descriptor);
        break;
      } catch (error) {
        connectionError = error;
      }
    }
    if (!client) {
      throw new Error(
        `没有可连接的运行中 Session${connectionError instanceof Error ? `：${connectionError.message}` : ""}`,
      );
    }
    try {
      if (command === "status") printJson(await client.status());
      else if (command === "snapshot") printJson(await client.snapshot());
      else if (command === "send") {
        printJson(await client.send({ text: value }, idempotencyKey ?? randomUUID()));
      } else if (command === "wait") {
        printJson(await client.wait({ timeoutMs: value ? parsePositiveInteger(value, "timeout-ms") : 60_000 }));
      } else {
        const afterSequence = value ? parsePositiveInteger(value, "after-sequence", true) : 0;
        const subscription = await client.subscribe(afterSequence, printJson);
        await subscription.closed;
      }
    } finally {
      client.close();
    }
  } catch (error) {
    process.stderr.write(`vspi control 失败：${error instanceof Error ? error.message : "未知错误"}\n`);
    process.exitCode = 1;
  }
}

export function parseControlArguments(
  command: ControlCommand,
  argv: string[],
): { selector?: string; value?: string; idempotencyKey?: string } {
  if (command === "send") {
    const keyIndex = argv.indexOf("--idempotency-key");
    const idempotencyKey = keyIndex >= 0 ? argv[keyIndex + 1] : undefined;
    if (keyIndex >= 0 && (!idempotencyKey || idempotencyKey.length > 256)) {
      throw new Error("--idempotency-key 需要 1-256 字符的值");
    }
    const positional = keyIndex < 0 ? argv : argv.filter((_, index) => index !== keyIndex && index !== keyIndex + 1);
    if (positional.length === 0) throw new Error(controlUsage());
    if (positional.length === 1) {
      return { value: positional[0] as string, ...(idempotencyKey ? { idempotencyKey } : {}) };
    }
    return {
      selector: positional[0] as string,
      value: positional.slice(1).join(" "),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
  }
  if (command === "wait" || command === "watch") {
    if (argv.length === 0) return {};
    if (argv.length === 1) {
      const only = argv[0] as string;
      return /^\d+$/u.test(only) ? { value: only } : { selector: only };
    }
    return { selector: argv[0] as string, value: argv[1] as string };
  }
  return argv[0] === undefined ? {} : { selector: argv[0] };
}

async function resolveDescriptors(selector?: string): Promise<SessionControlDescriptor[]> {
  const directory = join(getAgentDir(), "session-controls");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch {
    throw new Error("没有运行中的可控 VSPi Session");
  }
  const descriptors = (
    await Promise.all(
      names.map(async (name) => {
        try {
          const value = JSON.parse(await readFile(join(directory, name), "utf8")) as SessionControlDescriptor;
          return value.version === SESSION_CONTROL_VERSION ? value : undefined;
        } catch {
          return undefined;
        }
      }),
    )
  ).filter((value): value is SessionControlDescriptor => value !== undefined);
  if (descriptors.length === 0) throw new Error("没有运行中的可控 VSPi Session");
  if (!selector || selector === "latest") {
    return descriptors.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }
  const absolute = resolve(selector);
  const matches = descriptors.filter(
    (descriptor) =>
      descriptor.sessionPath === absolute ||
      descriptor.sessionPath === selector ||
      descriptor.sessionPath.includes(selector),
  );
  if (matches.length === 0) throw new Error(`找不到运行中的 Session：${selector}`);
  if (matches.length > 1) {
    throw new Error(`Session selector 匹配到 ${matches.length} 个运行中会话，请使用更长 id 或完整路径`);
  }
  return matches;
}

function parsePositiveInteger(value: string, label: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) throw new Error(`${label} 必须是整数`);
  return parsed;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function controlUsage(): string {
  return [
    "用法：vspi control status|snapshot [session]",
    '      vspi control send [session] [--idempotency-key <key>] "<prompt>"',
    "      vspi control wait [session] [timeout-ms]",
    "      vspi control watch [session] [after-sequence]",
  ].join("\n");
}
