import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderModelRecord } from "../src/providers/config-service.js";
import {
  enrichBuiltinProvidersWithRemoteCatalog,
  fetchRemoteCatalog,
  mergeRemoteCatalog,
  parseRemoteCatalog,
} from "../src/providers/vsplab-catalog.js";

const localModels: ProviderModelRecord[] = [
  // 本地声明规格（长上下文）+ 调用兼容性
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", inheritFrom: "openai-codex", contextWindow: 1_050_000, maxTokens: 128_000 },
  // 本地 fallback：远程未登记时仍可用
  { id: "gpt-6-astra", name: "GPT-6 Astra", contextWindow: 1_050_000, maxTokens: 128_000, reasoning: true },
  // 本地独有（协议覆盖）
  { id: "k3", name: "Kimi K3", api: "openai-completions", inheritFrom: "kimi-coding" },
];

const jsonResponse = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });

describe("parseRemoteCatalog", () => {
  it("parses the OpenAI data[] style response with spec aliases", () => {
    const models = parseRemoteCatalog({
      data: [
        { id: "gpt-6-astra", context_window: 1_050_000, max_output_tokens: 128_000 },
        { id: "glm-5.3", name: "GLM 5.3" },
        "k3",
      ],
    });
    expect(models).toEqual([
      { id: "gpt-6-astra", contextWindow: 1_050_000, maxTokens: 128_000 },
      { id: "glm-5.3", name: "GLM 5.3" },
      { id: "k3" },
    ]);
  });

  it("parses the {models:[]} style and drops unusable entries", () => {
    const models = parseRemoteCatalog({
      models: [{ model: "glm-5.2", contextWindow: 200_000 }, { name: "no-id" }, 42, null, ""],
    });
    expect(models).toEqual([{ id: "glm-5.2", contextWindow: 200_000 }]);
  });

  it("parses /vsp/models metadata fields (reasoning/thinkingLevelMap/cost/input) and drops malformed ones", () => {
    const models = parseRemoteCatalog({
      models: [
        {
          id: "brand-new-model",
          reasoning: true,
          thinkingLevelMap: { low: "low", high: "high", off: null, bogus: "x" },
          cost: { input: 1.25, output: 10, cache_read: 0.125 },
          input: ["text", "image", "audio"],
        },
        // cost 只有 cache 字段（无 input/output）视为未提供
        { id: "cache-only-cost", cost: { cacheRead: 1 } },
      ],
    });
    expect(models).toEqual([
      {
        id: "brand-new-model",
        reasoning: true,
        input: ["text", "image"],
        thinkingLevelMap: { low: "low", high: "high", off: null },
        cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
      },
      { id: "cache-only-cost" },
    ]);
  });

  it("returns an empty list for unrecognized payloads and rejects non-positive specs", () => {
    expect(parseRemoteCatalog({ error: "boom" })).toEqual([]);
    expect(parseRemoteCatalog(null)).toEqual([]);
    expect(parseRemoteCatalog({ data: [{ id: "x", context_window: 0, max_output_tokens: -5 }] })).toEqual([
      { id: "x" },
    ]);
  });
});

describe("mergeRemoteCatalog", () => {
  it("returns the local catalog untouched when discovery is unavailable", () => {
    expect(mergeRemoteCatalog(localModels, undefined)).toEqual(localModels);
  });

  it("prefers remote specs but keeps local call-compatibility fields", () => {
    const merged = mergeRemoteCatalog(localModels, [
      // 远程修正了规格
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol (updated)", contextWindow: 2_000_000, maxTokens: 64_000 },
      // 远程只登记名单，规格回退本地声明
      { id: "gpt-6-astra" },
    ]);
    expect(merged[0]).toMatchObject({
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol (updated)",
      contextWindow: 2_000_000,
      maxTokens: 64_000,
      inheritFrom: "openai-codex", // 本地调用兼容性保留
    });
    expect(merged[1]).toMatchObject({
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      contextWindow: 1_050_000, // 远程缺省 → 本地 fallback
      reasoning: true,
    });
  });

  it("appends remote-only models and preserves local-only models as fallback", () => {
    const merged = mergeRemoteCatalog(localModels, [
      { id: "gpt-6-astra" },
      { id: "brand-new-model", name: "Brand New", contextWindow: 400_000 },
    ]);
    // 远程新模型：默认走 provider 协议，name 回退服务端值
    expect(merged[1]).toEqual({ id: "brand-new-model", name: "Brand New", contextWindow: 400_000 });
    // 本地独有模型不被远程缺席删除（尾部追加）；远程顺序优先
    expect(merged.map((model) => model.id)).toEqual(["gpt-6-astra", "brand-new-model", "gpt-5.6-sol", "k3"]);
    expect(merged[3]?.api).toBe("openai-completions");
  });

  it("restores effort and pricing on remote-only models via /vsp/models metadata", () => {
    // 标准 /v1/models 只登记名单时，远程新模型原本没有 effort 档位与定价；
    // /vsp/models 元数据声明 reasoning/cost 后合并结果完整可用。
    const merged = mergeRemoteCatalog(localModels, [
      {
        id: "brand-new-model",
        name: "Brand New",
        reasoning: true,
        cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
      },
    ]);
    expect(merged[0]).toEqual({
      id: "brand-new-model",
      name: "Brand New",
      reasoning: true,
      cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
    });
  });

  it("overrides local reasoning/cost only when the remote metadata declares them", () => {
    const merged = mergeRemoteCatalog(localModels, [
      // 只声明 cost：reasoning 保留本地 true；未声明字段不清空本地/继承值
      { id: "gpt-6-astra", cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } },
    ]);
    expect(merged[0]).toMatchObject({
      id: "gpt-6-astra",
      reasoning: true,
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      cost: { input: 2, output: 8 },
    });
  });
});

describe("fetchRemoteCatalog", () => {
  it("requests /models with credentials and /vsp/models metadata without, then merges by id", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const result = await fetchRemoteCatalog("https://relay.example/v1", "sk-test", {
      fetchImpl: async (input, init) => {
        const url = String(input);
        seen.push({ url, auth: new Headers(init?.headers).get("Authorization") });
        if (url === "https://relay.example/v1/models") {
          return jsonResponse({ data: [{ id: "gpt-6-astra" }, { id: "brand-new-model" }] });
        }
        return jsonResponse({
          models: [
            { id: "brand-new-model", reasoning: true, cost: { input: 1.25, output: 10 } },
            // 名单外的元数据登记不新增模型（存在性以 /models 为准）
            { id: "ghost-model", reasoning: true },
          ],
        });
      },
    });
    expect(seen).toEqual([
      { url: "https://relay.example/v1/models", auth: "Bearer sk-test" },
      { url: "https://relay.example/vsp/models", auth: null },
    ]);
    expect(result.models).toEqual([
      { id: "gpt-6-astra" },
      { id: "brand-new-model", reasoning: true, cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 } },
    ]);
    expect(result.error).toBeUndefined();
  });

  it("keeps roster discovery when the /vsp/models metadata endpoint is unavailable", async () => {
    const result = await fetchRemoteCatalog("https://relay.example/v1", "sk-test", {
      fetchImpl: async (input) => {
        if (String(input) === "https://relay.example/vsp/models") return new Response("not found", { status: 404 });
        return jsonResponse({ data: [{ id: "gpt-6-astra" }] });
      },
    });
    expect(result.models).toEqual([{ id: "gpt-6-astra" }]);
    expect(result.error).toBeUndefined();
  });

  it("reports HTTP errors without throwing", async () => {
    const result = await fetchRemoteCatalog("https://relay.example/v1", "sk-test", {
      fetchImpl: async () => new Response("denied", { status: 401 }),
    });
    expect(result.models).toEqual([]);
    expect(result.error).toBe("HTTP 401");
  });

  it("reports network failures without throwing", async () => {
    const result = await fetchRemoteCatalog("https://relay.example/v1", undefined, {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.error).toBe("ECONNREFUSED");
  });

  it("aborts when the upstream stalls beyond the timeout", async () => {
    const result = await fetchRemoteCatalog("https://relay.example/v1", undefined, {
      timeoutMs: 20,
      fetchImpl: ((_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as never,
    });
    expect(result.models).toEqual([]);
    expect(result.error).toContain("timeout after 20ms");
  });
});

describe("enrichBuiltinProvidersWithRemoteCatalog", () => {
  const builtins = [
    {
      id: "vsplab",
      name: "VSPLab",
      source: "builtin" as const,
      baseUrl: "https://api.vsplab.cn/v1",
      models: localModels,
    },
    { id: "other", name: "Other", source: "builtin" as const, models: [] },
  ];

  it("merges the remote catalog into the builtin provider copy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vspi-catalog-"));
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, JSON.stringify({ vsplab: { key: "sk-auth", type: "api" } }));
    const enriched = await enrichBuiltinProvidersWithRemoteCatalog(builtins, {
      authPath,
      fetchImpl: async () => jsonResponse({ data: [{ id: "gpt-6-astra" }, { id: "fresh-model" }] }),
    });
    const vsplab = enriched.providers.find((item) => item.id === "vsplab");
    expect(vsplab?.models.map((model) => model.id)).toEqual(["gpt-6-astra", "fresh-model", "gpt-5.6-sol", "k3"]);
    // 可见性联动使用远程登记 id 集合
    expect([...enriched.remoteModelIds]).toEqual(["gpt-6-astra", "fresh-model"]);
    // 其它 provider 不受影响，builtins 原数组不被修改
    expect(builtins[0]?.models).toHaveLength(3);
  });

  it("falls back to the builtin catalog when discovery fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vspi-catalog-"));
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, JSON.stringify({ vsplab: { key: "sk-auth", type: "api" } }));
    const enriched = await enrichBuiltinProvidersWithRemoteCatalog(builtins, {
      authPath,
      fetchImpl: async () => new Response("down", { status: 503 }),
    });
    expect(enriched.providers).toEqual(builtins);
    expect(enriched.remoteModelIds.size).toBe(0);
  });

  it("skips discovery without stored credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vspi-catalog-"));
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, JSON.stringify({ other: { key: "sk-x", type: "api" } }));
    let fetched = false;
    const enriched = await enrichBuiltinProvidersWithRemoteCatalog(builtins, {
      authPath,
      fetchImpl: async () => {
        fetched = true;
        return jsonResponse({ data: [] });
      },
    });
    expect(fetched).toBe(false);
    expect(enriched.providers).toEqual(builtins);
    expect(enriched.remoteModelIds.size).toBe(0);
    expect(await readFile(authPath, "utf8")).toContain("sk-x");
  });
});
