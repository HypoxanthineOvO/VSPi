export function deepSeekHarnessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env.VSPI_DEEPSEEK_HARNESS?.trim().toLowerCase();
  return configured !== "0" && configured !== "false" && configured !== "off";
}
