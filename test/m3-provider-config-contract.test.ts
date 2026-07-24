import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type ProviderRecord = {
  id: string;
  name: string;
  source: "builtin" | "global" | "project";
  baseUrl?: string;
  models: Array<{ id: string; name: string; contextWindow?: number }>;
};

type ProviderConfigService = {
  loadCatalog(): Promise<{ providers: ProviderRecord[]; hash: string; diagnostics: string[] }>;
  saveProjectOverlay(value: unknown, options: { expectedHash: string }): Promise<{ hash: string; path: string }>;
  validateProjectOverlay(value: unknown): void;
};

async function configModule() {
  const specifier = "../src/providers/config-service.js";
  return (await import(specifier)) as {
    createProviderConfigService(options: {
      cwd: string;
      agentDir: string;
      trustedProject: boolean;
      builtins: ProviderRecord[];
    }): ProviderConfigService;
  };
}

async function authModule() {
  const specifier = "../src/providers/auth-resolver.js";
  return (await import(specifier)) as {
    createProviderAuthResolver(options: {
      stored: Record<string, string>;
      env: Record<string, string | undefined>;
      session: Record<string, string>;
    }): {
      resolve(providerId: string): Promise<{ source: "session" | "stored" | "environment"; secret: string }>;
      describe(providerId: string): Promise<string>;
    };
  };
}

async function protocolModule() {
  const specifier = "../src/providers/protocol-probe.js";
  return (await import(specifier)) as {
    runProtocolProbe(options: {
      api: "openai-responses" | "openai-completions" | "anthropic-messages" | "google-generative-ai";
      baseUrl: string;
      model: string;
      apiKey: string;
      mode: "check-config" | "test-connection" | "minimal-generation";
      confirmCost?: () => Promise<boolean>;
    }): Promise<{ ok: boolean; diagnostic: string }>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("M3 ProviderCatalog and project overlay", () => {
  it("merges built-in, global and trusted project providers with source attribution and field override", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m3-catalog-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".vspi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: { openai: { baseUrl: "https://global.invalid", models: [{ id: "global", name: "Global" }] } },
      }),
    );
    await writeFile(
      join(cwd, ".vspi", "models.json"),
      JSON.stringify({ providers: { openai: { models: [{ id: "project", name: "Project" }] } } }),
    );
    const { createProviderConfigService } = await configModule();
    const service = createProviderConfigService({
      cwd,
      agentDir,
      trustedProject: true,
      builtins: [{ id: "openai", name: "OpenAI", source: "builtin", models: [{ id: "builtin", name: "Built-in" }] }],
    });

    const catalog = await service.loadCatalog();
    const openai = catalog.providers.find((provider) => provider.id === "openai");
    expect(openai).toMatchObject({ source: "project", baseUrl: "https://global.invalid" });
    expect(openai?.models.map((model) => model.id)).toEqual(["builtin", "global", "project"]);
    expect(catalog.hash).toMatch(/^[a-f0-9]{64}$/);

    const untrusted = createProviderConfigService({
      cwd,
      agentDir,
      trustedProject: false,
      builtins: [{ id: "openai", name: "OpenAI", source: "builtin", models: [] }],
    });
    expect((await untrusted.loadCatalog()).providers.find((provider) => provider.id === "openai")?.source).toBe(
      "global",
    );
  });

  it("validates schema, writes atomically, rejects stale expected hashes and recovers from damaged JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m3-atomic-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const { createProviderConfigService } = await configModule();
    const service = createProviderConfigService({ cwd, agentDir, trustedProject: true, builtins: [] });
    const initial = await service.loadCatalog();
    const saved = await service.saveProjectOverlay(
      { providers: { local: { baseUrl: "http://127.0.0.1:9999", models: [{ id: "m", name: "M" }] } } },
      { expectedHash: initial.hash },
    );
    expect(JSON.parse(await readFile(saved.path, "utf8"))).toHaveProperty("providers.local");
    await expect(service.saveProjectOverlay({ providers: {} }, { expectedHash: initial.hash })).rejects.toThrow(
      /conflict|hash|revision/i,
    );
    await writeFile(saved.path, "{ damaged json");
    const recovered = await service.loadCatalog();
    expect(recovered.providers).toEqual([]);
    expect(recovered.diagnostics.join(" ")).toMatch(/models\.json|JSON|损坏/i);
  });

  it("keeps built-in models when a trusted project overrides only Base URL and protocol", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-m3-provider-only-overlay-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".vspi"), { recursive: true });
    await writeFile(
      join(cwd, ".vspi", "models.json"),
      JSON.stringify({ providers: { openai: { baseUrl: "http://127.0.0.1:9999", protocol: "Responses" } } }),
    );
    const { createProviderConfigService } = await configModule();
    const service = createProviderConfigService({
      cwd,
      agentDir,
      trustedProject: true,
      builtins: [
        {
          id: "openai",
          name: "OpenAI",
          source: "builtin",
          models: [{ id: "builtin-model", name: "Built-in Model", contextWindow: 128_000 }],
        },
      ],
    });

    const provider = (await service.loadCatalog()).providers.find((entry) => entry.id === "openai");
    expect(provider).toMatchObject({
      source: "project",
      baseUrl: "http://127.0.0.1:9999",
      models: [expect.objectContaining({ id: "builtin-model", contextWindow: 128_000 })],
    });
  });

  it("accepts only mappable project protocols and nonempty text/image model input", async () => {
    const { createProviderConfigService } = await configModule();
    const service = createProviderConfigService({
      cwd: "/tmp/project-schema",
      agentDir: "/tmp/agent-schema",
      trustedProject: true,
      builtins: [],
    });
    for (const protocol of ["openai-responses", "OpenAI compatible", "anthropic-messages", "google-generative-ai"]) {
      expect(() =>
        service.validateProjectOverlay({
          providers: { valid: { protocol, models: [{ id: "m", name: "M", input: ["text", "image"] }] } },
        }),
      ).not.toThrow();
    }
    expect
      .soft(() => service.validateProjectOverlay({ providers: { bad: { protocol: "unknown-wire-protocol" } } }))
      .toThrow(/protocol|协议|支持/i);
    for (const input of [[], ["audio"], ["image"]]) {
      expect
        .soft(() =>
          service.validateProjectOverlay({
            providers: { bad: { protocol: "openai-responses", models: [{ id: "m", name: "M", input }] } },
          }),
        )
        .toThrow(/input|text|image/i);
    }
  });

  it.each([
    ["apiKey", "plaintext-secret"],
    ["token", "plaintext-secret"],
    ["headers", { Authorization: "Bearer plaintext-secret" }],
    ["headers", { "x-api-key": "plaintext-secret" }],
    ["apiKey", "!security find-generic-password -w"],
    ["baseUrl", "!curl https://credential.invalid"],
  ])("rejects project secret or command field %s", async (field, value) => {
    const { createProviderConfigService } = await configModule();
    const service = createProviderConfigService({
      cwd: "/tmp/project",
      agentDir: "/tmp/agent",
      trustedProject: true,
      builtins: [],
    });
    expect(() => service.validateProjectOverlay({ providers: { unsafe: { [field]: value } } })).toThrow(
      /secret|credential|command|header|不允许/i,
    );
  });
});

describe("M3 credential resolution without a secret manager", () => {
  it("uses Session temporary > Pi stored > environment and never reveals credential values", async () => {
    const { createProviderAuthResolver } = await authModule();
    const resolver = createProviderAuthResolver({
      stored: { openai: "STORED_SECRET_SENTINEL", anthropic: "STORED_ANTHROPIC_SENTINEL" },
      env: { OPENAI_API_KEY: "ENV_SECRET_SENTINEL", GOOGLE_API_KEY: "ENV_GOOGLE_SENTINEL" },
      session: { openai: "SESSION_SECRET_SENTINEL" },
    });
    expect(await resolver.resolve("openai")).toMatchObject({ source: "session", secret: "SESSION_SECRET_SENTINEL" });
    expect(await resolver.resolve("anthropic")).toMatchObject({
      source: "stored",
      secret: "STORED_ANTHROPIC_SENTINEL",
    });
    expect(await resolver.resolve("google")).toMatchObject({ source: "environment", secret: "ENV_GOOGLE_SENTINEL" });
    const descriptions = await Promise.all(["openai", "anthropic", "google"].map((id) => resolver.describe(id)));
    expect(descriptions.join(" ")).not.toMatch(/SESSION_SECRET|STORED_|ENV_/);
  });
});

describe("M3 protocol probes use only an explicit local endpoint", () => {
  it("checks configuration without opening a network connection", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local offline-check server did not bind");
    try {
      const { runProtocolProbe } = await protocolModule();
      await expect(
        runProtocolProbe({
          api: "openai-responses",
          baseUrl: `http://127.0.0.1:${address.port}`,
          model: "test-model",
          apiKey: "",
          mode: "check-config",
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it.each([
    ["openai-responses", "/v1/responses", "input"],
    ["openai-completions", "/v1/chat/completions", "messages"],
    ["anthropic-messages", "/v1/messages", "messages"],
    ["google-generative-ai", "/v1beta/models/test-model:generateContent", "contents"],
  ] as const)("maps %s request shape and redacts mapped errors", async (api, expectedPath, bodyField) => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        requests.push({ url: request.url ?? "", body: JSON.parse(body) as Record<string, unknown> });
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "rejected FAKE_PROTOCOL_SECRET" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local protocol server did not bind");
    try {
      const { runProtocolProbe } = await protocolModule();
      const confirmCost = vi.fn(async () => true);
      const result = await runProtocolProbe({
        api,
        baseUrl: `http://127.0.0.1:${address.port}`,
        model: "test-model",
        apiKey: "FAKE_PROTOCOL_SECRET",
        mode: "minimal-generation",
        confirmCost,
      });
      expect(confirmCost).toHaveBeenCalledOnce();
      expect(requests[0]?.url).toContain(expectedPath);
      expect(requests[0]?.body).toHaveProperty(bodyField);
      expect(result.ok).toBe(false);
      expect(result.diagnostic).not.toContain("FAKE_PROTOCOL_SECRET");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
