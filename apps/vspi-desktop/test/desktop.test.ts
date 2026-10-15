import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { transform } from "esbuild";
import { createServer } from "node:net";
import { connectKlient } from "@moonshot-ai/klient/tcp";
import { describe, expect, it, vi } from "vitest";
import { desktopEnabled } from "../src/main/feature.js";
import {
  connectSsh,
  quoteShell,
  sshArguments,
  sshOptionsSchema,
} from "../src/main/ssh.js";
import {
  connectLocal,
  localStartupError,
  unsupportedDesktopMessage,
} from "../src/main/local.js";
import {
  assertCompatibleHandshake,
  parseDiscoveryLine,
} from "../src/main/runtime.js";
import {
  describeLocalCommand,
  loadHosts,
  resolveLocalCommand,
  saveHosts,
} from "../src/main/hosts.js";
import { DesktopController } from "../src/main/controller.js";
import { createAskpass } from "../src/main/askpass.js";
import type { DesktopEvent } from "../src/shared.js";
import { formatSessionDate } from "../src/renderer/lib/dates.js";

vi.mock("../src/main/local.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/main/local.js")>()),
  connectLocal: vi.fn(),
}));
vi.mock("../src/main/ssh.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/main/ssh.js")>()),
  connectSsh: vi.fn(),
}));

describe("SSH connection boundary", () => {
  it("quotes paths without executing shell expansions", () => {
    expect(quoteShell("/tmp/user's project/$(id) `id`")).toBe(
      "'/tmp/user'\\''s project/$(id) `id`'",
    );
  });
  it.each([
    "-oProxyCommand=command",
    "host; command",
    "user@host\ncommand",
    "host name",
    "$(command)",
  ])("rejects unsafe destination %s", (host) => {
    expect(() => sshOptionsSchema.parse({ host })).toThrow();
  });
  it("uses host verification and honors a custom port without weakening SSH config", () => {
    const args = sshArguments({ host: "dev@example.test", port: 2222 });
    expect(args).toContain("StrictHostKeyChecking=ask");
    expect(args.slice(-2)).toEqual(["-p", "2222"]);
    expect(args.join(" ")).not.toContain("StrictHostKeyChecking=no");
  });
  it("rejects malformed ports and executable lines", () => {
    expect(() => sshOptionsSchema.parse({ host: "devbox", port: 0 })).toThrow();
    expect(() =>
      sshOptionsSchema.parse({ host: "devbox", executable: "vspi\ncommand" }),
    ).toThrow();
  });
});

describe("SSH authentication handoff", () => {
  it("requires the per-process token, answers once, and cancels pending prompts on shutdown", async () => {
    const events: DesktopEvent[] = [];
    const askpass = await createAskpass(
      process.execPath,
      "/tmp/example-client.cjs",
      (event) => events.push(event),
    );
    const url = `http://127.0.0.1:${askpass.env.VSPI_ASKPASS_PORT}/`;
    const headers = {
      authorization: `Bearer ${askpass.env.VSPI_ASKPASS_TOKEN}`,
    };
    let closed = false;
    try {
      expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(
        403,
      );
      const pending = fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "Password:" }),
      });
      await vi.waitFor(() => {
        expect(events).toHaveLength(1);
      });
      const event = events[0]!;
      if (event.type !== "auth") throw new Error("missing auth event");
      askpass.answer(event.id, "TEST_ONLY_PASSWORD");
      expect(await (await pending).json()).toEqual({
        answer: "TEST_ONLY_PASSWORD",
      });
      expect(JSON.stringify(events)).not.toContain("TEST_ONLY_PASSWORD");
      const cancelled = fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "Continue (yes/no)?" }),
      });
      await vi.waitFor(() => {
        expect(events).toHaveLength(2);
      });
      await askpass.close();
      closed = true;
      expect(await (await cancelled).json()).toEqual({ answer: null });
    } finally {
      if (!closed) await askpass.close();
    }
  });
});

it("preserves connection-refused errors so a starting SSH tunnel can be retried", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await expect(
    connectKlient({ port: address.port, token: "TEST_ONLY_TOKEN" }),
  ).rejects.toMatchObject({ code: "ECONNREFUSED" });
});

describe("runtime discovery", () => {
  const discovery = {
    desktopProtocol: 1,
    protocolVersion: 1,
    runtimeId: "a".repeat(64),
    version: "2.7.0",
    homeDir: "/home/example/.vspi",
    ipcPath: "/run/vspi/example.sock",
    httpPort: 46000,
    token: "TEST_ONLY_TOKEN",
  };
  it("parses the discovery JSON shared by local and SSH transports", () => {
    expect(parseDiscoveryLine(JSON.stringify(discovery))).toMatchObject(
      discovery,
    );
    expect(parseDiscoveryLine("not json")).toBeUndefined();
    expect(
      parseDiscoveryLine(JSON.stringify({ ...discovery, token: "" })),
    ).toBeUndefined();
  });
  it("rejects handshakes that miss a required capability", () => {
    const handshake = {
      runtimeId: discovery.runtimeId,
      desktopProtocol: 1,
      protocolVersion: 1,
      version: discovery.version,
      capabilities: [
        "klient-tunnel-v1",
        "history-snapshot-v1",
        "prompt-id-v1",
      ],
    };
    const metadata = parseDiscoveryLine(JSON.stringify(discovery))!;
    expect(() => assertCompatibleHandshake(handshake, metadata)).not.toThrow();
    expect(() =>
      assertCompatibleHandshake(
        { ...handshake, capabilities: ["klient-tunnel-v1"] },
        metadata,
      ),
    ).toThrow("协议不兼容");
    expect(() =>
      assertCompatibleHandshake(
        { ...handshake, runtimeId: "b".repeat(64) },
        metadata,
      ),
    ).toThrow("协议不兼容");
  });
});

describe("local executable resolution", () => {
  it("prefers saved config, then env, then a repo dev build, then PATH", () => {
    const deps = {
      fileExists: (path: string) => path.endsWith("dist/main.mjs"),
      pathLookup: () => "/usr/local/bin/vspi",
    };
    expect(
      resolveLocalCommand(
        { executable: "/opt/vspi", executableArgs: ["--flag"] },
        {},
        "/app",
        deps,
      ),
    ).toMatchObject({
      executable: "/opt/vspi",
      executableArgs: ["--flag"],
      source: "saved",
    });
    expect(
      resolveLocalCommand(
        {},
        { VSPI_DESKTOP_EXECUTABLE: "/env/vspi" },
        "/app",
        deps,
      ),
    ).toMatchObject({ executable: "/env/vspi", source: "env" });
    expect(resolveLocalCommand({}, {}, "/app", deps)).toMatchObject({
      executable: "node",
      executableArgs: [join("/app", "..", "vspi", "dist", "main.mjs")],
      source: "dev",
    });
    expect(
      resolveLocalCommand({}, {}, "/app", {
        fileExists: () => false,
        pathLookup: () => "/usr/local/bin/vspi",
      }),
    ).toMatchObject({ executable: "/usr/local/bin/vspi", source: "path" });
    expect(
      describeLocalCommand(
        { executable: "vspi", executableArgs: [], source: "path" },
        "/data",
      ),
    ).toBe("vspi daemon desktop --home-dir /data");
  });
});

describe("local startup errors", () => {
  it("maps daemon usage text to the unsupported Desktop protocol message", () => {
    const error = localStartupError(
      "Usage: vspi daemon [start|status|stop|logs]\n",
      "vspi",
    );
    expect(error.message).toBe(unsupportedDesktopMessage);
    expect(error.message).toContain("Desktop 协议");
  });
  it("surfaces a runtime compatibility refusal verbatim with the home hint", () => {
    const error = localStartupError(
      "runtime protocol version mismatch\n",
      "vspi",
    );
    expect(error.message).toContain("runtime protocol version mismatch");
    expect(error.message).toContain("独立数据目录");
  });
  it("reports a spawn failure when no output was produced", () => {
    expect(localStartupError("", "/missing/vspi").message).toContain(
      "/missing/vspi",
    );
  });
});

describe("hosts registry", () => {
  it("loads defaults, round-trips remotes, and keeps the local host implicit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop hosts "));
    const path = join(directory, "hosts.json");
    try {
      expect(await loadHosts(path)).toEqual({ local: {}, remotes: [] });
      await saveHosts(path, {
        local: { homeDir: "/data" },
        remotes: [
          {
            id: "dev",
            label: "开发机",
            host: "dev@example.test",
            port: 2222,
            executable: "vspi",
          },
        ],
      });
      const loaded = await loadHosts(path);
      expect(loaded.local).toEqual({ homeDir: "/data" });
      expect(loaded.remotes).toHaveLength(1);
      expect(loaded.remotes[0]).toMatchObject({ id: "dev", port: 2222 });
      await writeFile(path, "not json");
      let backupName = "";
      expect(
        await loadHosts(path, (name) => {
          backupName = name;
        }),
      ).toEqual({ local: {}, remotes: [] });
      expect(backupName).toMatch(/^hosts\.json\.invalid-\d+$/);
      expect(await readFile(join(directory, backupName), "utf8")).toBe(
        "not json",
      );
      await writeFile(path, JSON.stringify({ remotes: [{ id: "bad id" }] }));
      expect(await loadHosts(path)).toEqual({ local: {}, remotes: [] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("compact session dates", () => {
  const now = new Date("2026-10-15T14:30:00");
  it("formats same-day as HH:mm, same-year as M月D日, and older as YYYY/M/D", () => {
    expect(formatSessionDate("2026-10-15T09:05:00", now)).toBe("09:05");
    expect(formatSessionDate("2026-03-02T23:59:00", now)).toBe("3月2日");
    expect(formatSessionDate("2025-12-31T12:00:00", now)).toBe("2025/12/31");
  });
});

describe("session view emit suppression", () => {
  it("does not re-emit a session view whose signature is unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop controller "));
    const events: DesktopEvent[] = [];
    const controller = new DesktopController(process.env, (event) => {
      events.push(event);
    }, { hostsPath: join(directory, "hosts.json"), appPath: "/missing" });
    let revision = 0;
    const historyPage = () => ({
      items: [{ role: "user", content: [{ type: "text", text: "hi" }], toolCalls: [], id: `m${revision}` }],
      total: 1,
      revision,
      truncated: false,
      activity: {},
      effort: "high",
    });
    const agent = {
      watchHistory: async function* () {
        yield { kind: "event" };
        yield { kind: "event" };
        yield { kind: "event" };
      },
      getHistory: async () => historyPage(),
      getPermission: async () => "manual" as const,
      getModel: async () => "stub-model",
    };
    const session = {
      restore: async () => true,
      agent: () => agent,
      approvals: { list: async () => [] },
      questions: { list: async () => [] },
      terminals: {},
    };
    const runtime = {
      klient: { session: () => session },
      info: {
        kind: "local" as const,
        runtimeId: "a".repeat(64),
        version: "0.0.0",
        homeDir: "/data",
        host: "localhost",
        label: "本机",
      },
      request: async () => ({}),
      close: async () => {},
    };
    Object.assign(controller as object, { runtime });
    try {
      const view = (await controller.call("open", {
        sessionId: "s1",
      })) as unknown;
      expect(view).toBeTypeOf("object");
      await vi.waitFor(
        () => {
          expect(
            events.filter((event) => event.type === "session"),
          ).toHaveLength(1);
        },
        { timeout: 3000 },
      );
      // identical snapshots across later refreshes must not emit again
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(
        events.filter((event) => event.type === "session"),
      ).toHaveLength(1);
      revision = 1;
      await vi.waitFor(
        () => {
          expect(
            events.filter((event) => event.type === "session"),
          ).toHaveLength(2);
        },
        { timeout: 3000 },
      );
    } finally {
      await controller.disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("host switching", () => {
  it("keeps the working host connected when a remote switch fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop hosts "));
    await writeFile(
      join(directory, "hosts.json"),
      JSON.stringify({
        local: {},
        remotes: [
          { id: "loop", label: "回环", host: "nobody@127.0.0.1", port: 9 },
        ],
      }),
    );
    const closed = vi.fn(async () => {});
    const runtime = {
      klient: {
        global: { sessions: { list: async () => ({ items: [] }) } },
        session: vi.fn(),
      },
      info: {
        kind: "local" as const,
        runtimeId: "a".repeat(64),
        version: "0.0.0",
        homeDir: "/data",
        host: "localhost",
        label: "本机",
      },
      request: async () => ({}),
      close: closed,
    };
    vi.mocked(connectLocal).mockResolvedValue(runtime as never);
    vi.mocked(connectSsh).mockRejectedValue(new Error("ssh refused"));
    const controller = new DesktopController(process.env, () => {}, {
      hostsPath: join(directory, "hosts.json"),
      appPath: "/missing",
    });
    try {
      const first = (await controller.call("connectHost", {
        id: "local",
      })) as { kind: string };
      expect(first.kind).toBe("local");
      await expect(
        controller.call("connectHost", { id: "loop" }),
      ).rejects.toThrow("ssh refused");
      expect(closed).not.toHaveBeenCalled();
      await expect(
        controller.call("sessions", {}),
      ).resolves.toMatchObject({ items: [] });
    } finally {
      await controller.disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("keeps the Desktop preview opt-in and gives its flag precedence over the master flag", () => {
  expect(desktopEnabled({})).toBe(false);
  expect(desktopEnabled({ KIMI_CODE_EXPERIMENTAL_DESKTOP: "1" })).toBe(true);
  expect(desktopEnabled({ KIMI_CODE_EXPERIMENTAL_FLAG: "1" })).toBe(true);
  expect(
    desktopEnabled({
      KIMI_CODE_EXPERIMENTAL_FLAG: "1",
      KIMI_CODE_EXPERIMENTAL_DESKTOP: "0",
    }),
  ).toBe(false);
});

it.skipIf(process.platform !== "win32")(
  "launches the Windows askpass executable without a command shell or losing the prompt",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop askpass "));
    const client = join(directory, "client.cjs");
    const source = await readFile(
      new URL("../src/main/askpass-client.ts", import.meta.url),
      "utf8",
    );
    await writeFile(
      client,
      (await transform(source, { loader: "ts", format: "cjs" })).code,
    );
    const events: DesktopEvent[] = [];
    const askpass = await createAskpass(
      process.execPath,
      client,
      (event) => {
        events.push(event);
      },
      "win32",
    );
    try {
      const prompt = 'Password for user@example.test (& | % " unicode 中文):';
      const pending = promisify(execFile)(askpass.env.SSH_ASKPASS, [prompt], {
        env: askpass.env,
        timeout: 10000,
      });
      await vi.waitFor(() => {
        expect(events).toHaveLength(1);
      });
      const event = events[0]!;
      if (event.type !== "auth") throw new Error("missing auth event");
      expect(event.prompt).toBe(prompt);
      askpass.answer(event.id, "TEST_ONLY_PASSWORD");
      expect((await pending).stdout).toBe("TEST_ONLY_PASSWORD\n");
    } finally {
      await askpass.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
