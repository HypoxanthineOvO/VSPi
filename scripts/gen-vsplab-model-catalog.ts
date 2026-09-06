/**
 * 生成 VSPLab 中转站非标准模型元数据接口（GET /vsp/models）所需的静态 JSON。
 *
 * 数据源 = VSPi 内置 vsplab 目录（src/providers/builtins.ts）按 `inheritFrom`
 * 解析 Pi 上游目录后的最终结果，即“VSPi 当前掌握的模型信息”。生成文件部署到
 * 中转站（/etc/vsp-sub2api/model-catalog.json，由 nginx 精确匹配 /vsp/models 直接对外），
 * 供 VSPi 启动发现流程远程补强 reasoning / cost / 上下文规格等字段——
 * 标准 /v1/models 只登记名单，这些字段无从得知，导致远程优先合并后 effort 选项丢失。
 *
 * 契约说明：
 * - models 为数组；条目字段全部可选（缺省即“未知”，VSPi 保留本地声明，不会反向清空）。
 * - effort 信息两个字段：`reasoning`（bool，effort 档位开关）与可选的 `effortLevels`
 *   （显式档位数组，如 ["off","low","medium","high"]，可表达部分档位模型）。
 * - 名单权威仍是 /v1/models；本文件只补元数据，不决定模型存在性。
 * - cost 单位：美元 / 百万 token（与 VSPi inputUsdPerMillion 一致）。
 * - 新模型上手：手工在 models 里追加 {id, name, reasoning, cost, contextWindow, maxTokens} 即可。
 *
 * 用法：npx tsx scripts/gen-vsplab-model-catalog.ts [输出路径]（缺省打印到 stdout）
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EFFORT_LEVELS } from "../src/domain/types.js";
import { BUILTIN_PROVIDERS } from "../src/providers/builtins.js";
import type { ProviderModelRecord } from "../src/providers/config-service.js";

interface PiCatalogModel {
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** Pi 上游目录数据目录定位：从脚本位置逐级向上探测 node_modules 内的 pi-ai 数据目录。 */
function resolvePiProviderDataDir(): string {
  const suffixes = [
    join("@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"),
    join("@earendil-works", "pi-ai", "dist", "providers", "data"),
  ];
  let dir = import.meta.dirname;
  for (;;) {
    for (const suffix of suffixes) {
      const candidate = join(dir, "node_modules", suffix);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("找不到 pi-ai providers/data 目录（请先 npm install）");
}

function loadPiCatalog(dataDir: string): Map<string, Record<string, PiCatalogModel>> {
  const catalog = new Map<string, Record<string, PiCatalogModel>>();
  for (const file of readdirSync(dataDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      // 目录文件结构为 { <api名>: { <模型id>: 条目 } }，按 api 组展平成模型表。
      const flattened: Record<string, PiCatalogModel> = {};
      for (const group of Object.values(
        JSON.parse(readFileSync(join(dataDir, file), "utf8")) as Record<string, unknown>,
      )) {
        if (group && typeof group === "object") Object.assign(flattened, group);
      }
      catalog.set(file.replace(/\.json$/, ""), flattened);
    } catch {
      // 单个目录文件损坏时跳过，不影响其余 provider
    }
  }
  return catalog;
}

/** 与 src/providers/runtime-registration.ts 的 resolveInheritedModel 同语义的纯数据解析。 */
function resolveModel(
  model: ProviderModelRecord,
  piCatalog: Map<string, Record<string, PiCatalogModel>>,
): Record<string, unknown> {
  const upstream = model.inheritFrom ? piCatalog.get(model.inheritFrom)?.[model.id] : undefined;
  if (model.inheritFrom && !upstream) {
    throw new Error(`${model.id}: inheritFrom "${model.inheritFrom}" 在 Pi 目录中无同名条目`);
  }
  const reasoning = model.reasoning ?? upstream?.reasoning;
  const input = model.input ?? upstream?.input;
  const contextWindow = model.contextWindow ?? upstream?.contextWindow;
  const maxTokens = model.maxTokens ?? upstream?.maxTokens;
  const cost = model.cost ?? upstream?.cost;
  return {
    id: model.id,
    name: model.name,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(reasoning === true
      ? { effortLevels: EFFORT_LEVELS.filter((level) => level !== "xhigh" && level !== "max") }
      : {}),
    ...(input ? { input: [...input] } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(cost
      ? {
          cost: {
            input: cost.input ?? 0,
            output: cost.output ?? 0,
            cacheRead: cost.cacheRead ?? 0,
            cacheWrite: cost.cacheWrite ?? 0,
          },
        }
      : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
  };
}

async function main(): Promise<void> {
  const provider = BUILTIN_PROVIDERS.find((item) => item.id === "vsplab");
  if (!provider) throw new Error("内置目录缺少 vsplab provider");
  const piCatalog = loadPiCatalog(resolvePiProviderDataDir());
  const models = provider.models.map((model) => resolveModel(model, piCatalog));
  const payload = {
    version: 1,
    source: "vspi builtin vsplab catalog",
    generatedAt: new Date().toISOString(),
    models,
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const target = process.argv[2];
  if (target) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, json, "utf8");
    process.stdout.write(`${target}（${models.length} 个模型）\n`);
  } else {
    process.stdout.write(json);
  }
}

await main();
