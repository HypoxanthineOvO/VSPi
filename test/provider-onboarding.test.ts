import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_PROVIDERS } from "../src/providers/builtins.js";
import { createProviderConfigService } from "../src/providers/config-service.js";
import { customProviderId, discoverProviderModels, modelsFromManualInput } from "../src/providers/custom-provider.js";
import { registerBuiltinProviders } from "../src/providers/runtime-registration.js";
import { AuthDialog } from "../src/ui/auth-dialog.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider onboarding", () => {
  it("registers VSPLab in a fresh ModelRuntime used by init", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    registerBuiltinProviders(runtime, BUILTIN_PROVIDERS);

    const provider = runtime.getProvider("vsplab");
    expect(provider?.name).toBe("VSPLab");
    expect(provider?.baseUrl).toBe("https://api.vsplab.cn/v1");
    expect(provider?.auth.apiKey?.login).toBeTypeOf("function");
    expect(runtime.getModels("vsplab").map((model) => model.id)).toContain("gpt-5.6-sol");
  });

  it("discovers OpenAI-compatible models without exposing the API key in the URL", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://relay.example/v1/models");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer sk-secret" });
      return new Response(JSON.stringify({ data: [{ id: "gpt-example" }, { id: "gpt-example" }, { id: "other" }] }), {
        status: 200,
      });
    });

    const models = await discoverProviderModels(
      {
        name: "Relay",
        baseUrl: "https://relay.example/v1",
        apiKey: "sk-secret",
        protocol: "openai-responses",
      },
      { fetch: fetcher as typeof fetch },
    );

    expect(models.map((model) => model.id)).toEqual(["gpt-example", "other"]);
    expect(customProviderId("中文中转站", "https://relay.example/v1")).toMatch(/^custom-[a-f0-9]{8}$/u);
    expect(customProviderId("Relay", "https://one.example/v1")).not.toBe(
      customProviderId("Relay", "https://two.example/v1"),
    );
    expect(modelsFromManualInput("model-a, model-b，model-a").map((model) => model.id)).toEqual(["model-a", "model-b"]);
  });

  it("atomically saves a global custom provider while keeping its API key in Pi auth storage", async () => {
    vi.stubEnv("PI_OFFLINE", "1");
    const root = await mkdtemp(join(tmpdir(), "vspi-provider-"));
    const agentDir = join(root, "agent");
    const modelsPath = join(agentDir, "models.json");
    const authPath = join(agentDir, "auth.json");
    const service = createProviderConfigService({ cwd: root, agentDir, trustedProject: false, builtins: [] });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      modelsPath,
      `${JSON.stringify({
        metadata: { keep: true },
        providers: {
          existing: {
            name: "Existing",
            baseUrl: "https://existing.example/v1",
            api: "openai-completions",
            apiKey: "$EXISTING_API_KEY",
            models: [{ id: "existing-model", name: "Existing Model" }],
          },
        },
      })}\n`,
    );

    const saved = await service.saveGlobalProvider("custom-relay", {
      name: "Relay",
      baseUrl: "https://relay.example/v1",
      protocol: "openai-completions",
      models: [{ id: "relay-model", name: "Relay Model" }],
    });
    expect(saved.path).toBe(modelsPath);
    expect((await stat(modelsPath)).mode & 0o777).toBe(0o600);

    const runtime = await ModelRuntime.create({ modelsPath, authPath, allowModelNetwork: false });
    await runtime.login("custom-relay", "api_key", {
      prompt: async () => "sk-stored-only-in-auth",
      notify: () => {},
    });

    const modelsJson = await readFile(modelsPath, "utf8");
    const authJson = await readFile(authPath, "utf8");
    expect(modelsJson).not.toContain("sk-stored-only-in-auth");
    expect(modelsJson).toContain("https://relay.example/v1");
    expect(modelsJson).toContain("$EXISTING_API_KEY");
    expect(modelsJson).toContain('"keep": true');
    expect(authJson).toContain("sk-stored-only-in-auth");
    expect(runtime.getModel("custom-relay", "relay-model")).toBeDefined();
  });

  it("completes Kimi device authorization by polling after the browser step", async () => {
    const root = await mkdtemp(join(tmpdir(), "vspi-kimi-"));
    let tokenPolls = 0;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/oauth/device_authorization") {
        response.end(
          JSON.stringify({
            device_code: "device-secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://auth.kimi.test/device",
            verification_uri_complete: "https://auth.kimi.test/device?code=ABCD-EFGH",
            interval: 0.01,
            expires_in: 30,
          }),
        );
        return;
      }
      if (request.url === "/api/oauth/token") {
        tokenPolls += 1;
        response.end(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock OAuth server did not bind");
    vi.stubEnv("KIMI_CODE_OAUTH_HOST", `http://127.0.0.1:${address.port}`);
    vi.stubEnv("PI_OFFLINE", "1");

    try {
      const runtime = await ModelRuntime.create({
        modelsPath: null,
        authPath: join(root, "auth.json"),
        allowModelNetwork: false,
      });
      const dialog = new AuthDialog("Kimi For Coding", vi.fn(), vi.fn());
      await runtime.login("kimi-coding", "oauth", dialog);

      expect(tokenPolls).toBe(1);
      expect(await runtime.listCredentials()).toContainEqual({ providerId: "kimi-coding", type: "oauth" });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });
});
