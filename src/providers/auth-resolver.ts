export type ProviderAuthSource = "session" | "stored" | "environment";

export interface ProviderAuthResolverOptions {
  session: Record<string, string>;
  stored: Record<string, string>;
  env: Record<string, string | undefined>;
}

export function createProviderAuthResolver(options: ProviderAuthResolverOptions) {
  async function resolve(providerId: string): Promise<{ source: ProviderAuthSource; secret: string }> {
    const session = options.session[providerId];
    if (session) return { source: "session", secret: session };
    const stored = options.stored[providerId];
    if (stored) return { source: "stored", secret: stored };
    const environment = environmentSecret(providerId, options.env);
    if (environment) return { source: "environment", secret: environment };
    throw new Error(`Provider ${providerId} 未配置 credential`);
  }

  async function describe(providerId: string): Promise<string> {
    try {
      const credential = await resolve(providerId);
      if (credential.source === "session") return "Session temporary credential";
      if (credential.source === "stored") return "Pi stored credential";
      return "Environment credential";
    } catch {
      return "未配置 credential";
    }
  }

  return { resolve, describe };
}

function environmentSecret(providerId: string, env: Record<string, string | undefined>): string | undefined {
  const normalized = providerId.replace(/[^a-z0-9]/gi, "_").toUpperCase();
  const names =
    providerId === "google"
      ? ["GOOGLE_API_KEY", "GEMINI_API_KEY"]
      : providerId === "anthropic"
        ? ["ANTHROPIC_API_KEY"]
        : providerId === "openai"
          ? ["OPENAI_API_KEY"]
          : [`${normalized}_API_KEY`];
  return names.map((name) => env[name]).find((value): value is string => Boolean(value));
}
