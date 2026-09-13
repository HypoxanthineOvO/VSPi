const FEATURES = {
  feedback: { env: 'KIMI_CODE_EXPERIMENTAL_VSPI_FEEDBACK', default: true },
  distribution: { env: 'KIMI_CODE_EXPERIMENTAL_VSPI_DISTRIBUTION', default: false },
} as const;

export function experimentalEnabled(
  feature: keyof typeof FEATURES,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const enabled = (value: string | undefined) =>
    value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  if (enabled(env.KIMI_CODE_EXPERIMENTAL_FLAG)) return true;
  const value = env[FEATURES[feature].env];
  return value === undefined ? FEATURES[feature].default : enabled(value);
}

export function requireExperimental(feature: keyof typeof FEATURES): void {
  if (!experimentalEnabled(feature))
    throw new Error(`此功能尚未正式启用；本地验收可设置 ${FEATURES[feature].env}=true`);
}
