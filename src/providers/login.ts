import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderAuthInteraction } from "../backend/types.js";

type ProviderLoginRuntime = {
  login?: ModelRuntime["login"];
  refresh?: ModelRuntime["refresh"];
};

export function isRemoteTerminal(): boolean {
  return Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
}

/** OpenRouter's current upstream OAuth implementation only accepts a loopback callback. */
export function oauthAvailableInCurrentTerminal(providerId: string): boolean {
  return !isRemoteTerminal() || providerId !== "openrouter";
}

/** Persist a credential without turning login into a blocking remote catalog refresh. */
export async function loginProviderWithoutModelNetwork(
  runtime: ProviderLoginRuntime,
  providerId: string,
  type: "api_key" | "oauth",
  interaction: ProviderAuthInteraction,
): Promise<void> {
  if (!runtime.login) throw new Error("当前 Pi runtime 不支持交互式登录");
  const originalRefresh = runtime.refresh;
  if (!originalRefresh) {
    await runtime.login(providerId, type, interaction);
    return;
  }
  runtime.refresh = (options = {}) => originalRefresh.call(runtime, { ...options, allowNetwork: false });
  try {
    await runtime.login(providerId, type, interaction);
  } finally {
    runtime.refresh = originalRefresh;
  }
}
