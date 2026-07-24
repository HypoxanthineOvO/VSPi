import { PiRuntimeBackend, type PiRuntimeBackendOptions } from "./pi-runtime-backend.js";

export type PiBackendOptions = PiRuntimeBackendOptions;

/**
 * Public Pi adapter. AgentSessionRuntime is the sole production owner for
 * runtime.newSession(), runtime.switchSession(), and runtime.fork().
 */
export class PiBackend extends PiRuntimeBackend {}
