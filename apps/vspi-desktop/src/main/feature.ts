export function desktopEnabled(env: NodeJS.ProcessEnv): boolean {
  const value =
    env["KIMI_CODE_EXPERIMENTAL_DESKTOP"] ?? env["KIMI_CODE_EXPERIMENTAL_FLAG"];
  return (
    value !== undefined &&
    ["1", "true", "yes", "on"].includes(value.toLowerCase())
  );
}
