import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { EffortLevel } from "../domain/types.js";
import type { ProviderLayer, ProviderRecord } from "./config-service.js";
import { normalizeProviderApi } from "./config-service.js";

type RuntimeRegistrar = Pick<ModelRuntime, "registerProvider" | "getModel">;

interface RuntimeProviderModel {
  id: string;
  name: string;
  api?: string;
  baseUrl?: string;
  input?: string[];
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<EffortLevel, string | null>>;
  contextWindow?: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    tiers?: unknown;
  };
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: object;
}

/** Register VSPi-owned providers through one path shared by startup and init. */
export function registerBuiltinProviders(runtime: RuntimeRegistrar, providers: readonly ProviderRecord[]): void {
  for (const provider of providers) {
    runtime.registerProvider(provider.id, normalizeBuiltinProvider(provider, runtime) as never);
  }
}

export function normalizeBuiltinProvider(provider: ProviderRecord, runtime?: Pick<ModelRuntime, "getModel">) {
  const envVar = `${provider.id.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_API_KEY`;
  const api = provider.protocol
    ? normalizeProviderApi(provider.protocol, "provider.protocol")
    : provider.api
      ? normalizeProviderApi(provider.api, "provider.api")
      : "openai-completions";
  return {
    name: provider.name,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    apiKey: `$${envVar}`,
    models: provider.models.map((model) => normalizeRuntimeModel(resolveInheritedModel(provider, model, runtime), api)),
  };
}

/**
 * Merge shared model metadata from the upstream Pi catalog (contextWindow, maxTokens,
 * input capabilities, reasoning, thinking map, cost tiers). VSPi records only override
 * fields they explicitly set. Missing upstream entries fail closed: guessing a context
 * window here is how the 1.05M/272K drift happened.
 */
function resolveInheritedModel(
  provider: ProviderRecord,
  model: ProviderRecord["models"][number],
  runtime: Pick<ModelRuntime, "getModel"> | undefined,
): RuntimeProviderModel {
  if (!provider.inheritModelsFrom) return model;
  const upstream = runtime?.getModel(provider.inheritModelsFrom, model.id);
  if (!upstream) {
    throw new Error(
      `${provider.name} model ${model.id} requires the Pi ${provider.inheritModelsFrom} catalog entry, but it is missing`,
    );
  }
  const thinkingLevelMap = model.thinkingLevelMap ?? upstream.thinkingLevelMap;
  return {
    id: model.id,
    name: model.name || upstream.name,
    reasoning: model.reasoning ?? upstream.reasoning,
    ...(thinkingLevelMap
      ? { thinkingLevelMap: thinkingLevelMap as NonNullable<RuntimeProviderModel["thinkingLevelMap"]> }
      : {}),
    input: model.input ?? upstream.input,
    cost: model.cost ?? upstream.cost,
    contextWindow: model.contextWindow ?? upstream.contextWindow,
    maxTokens: model.maxTokens ?? upstream.maxTokens,
    ...(upstream.compat ? { compat: upstream.compat as object } : {}),
  };
}

export function normalizeProjectProvider(
  provider: ProviderLayer,
  inheritedModels: readonly RuntimeProviderModel[] = [],
) {
  const api = provider.protocol
    ? normalizeProviderApi(provider.protocol, "provider.protocol")
    : provider.api
      ? normalizeProviderApi(provider.api, "provider.api")
      : provider.models
        ? "openai-completions"
        : undefined;
  const models = provider.models ?? (api ? inheritedModels : undefined);
  return {
    ...(provider.name ? { name: provider.name } : {}),
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(api ? { api } : {}),
    ...(provider.headers ? { headers: provider.headers } : {}),
    ...(models
      ? {
          models: models.map((model) => ({
            ...normalizeRuntimeModel(
              model,
              api ?? normalizeProviderApi(model.api ?? "openai-completions", "model.api"),
            ),
            ...(provider.models && model.baseUrl ? { baseUrl: model.baseUrl } : {}),
            ...(model.headers ? { headers: model.headers } : {}),
          })),
        }
      : {}),
  };
}

function normalizeRuntimeModel(model: RuntimeProviderModel, api: string) {
  return {
    id: model.id,
    name: model.name,
    api,
    reasoning: model.reasoning ?? false,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: normalizeModelInput(model.input),
    cost: {
      ...model.cost,
      input: model.cost?.input ?? model.inputUsdPerMillion ?? 0,
      output: model.cost?.output ?? model.outputUsdPerMillion ?? 0,
      cacheRead: model.cost?.cacheRead ?? 0,
      cacheWrite: model.cost?.cacheWrite ?? 0,
    },
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 8_192,
    ...(model.compat ? { compat: model.compat } : {}),
  };
}

function normalizeModelInput(input: readonly string[] | undefined): Array<"text" | "image"> {
  const normalized = (input ?? ["text"]).filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return normalized.includes("text") ? normalized : ["text", ...normalized];
}
