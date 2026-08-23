import type { BackendMode } from "./adaptive-backend.js";

/** 按环境变量解析后端模式：fixture（VSPi_FIXTURE=1 / VSPi_BACKEND=fixture）完全离线。 */
export function resolveBackendMode(): BackendMode {
  return process.env.VSPi_FIXTURE === "1" || process.env.VSPi_BACKEND === "fixture" ? "fixture" : "pi";
}
