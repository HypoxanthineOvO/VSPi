import { type PolicyLevel, resolveEffectivePolicy } from "./execution-policy.js";

export interface StartupSecuritySnapshot {
  recovery: boolean;
  policy: PolicyLevel;
  boundary: "Sandboxed" | "Host";
  trustedProject: boolean;
  resourceScope: "workspace" | "global-only";
  projectSettings: boolean;
  extensions: boolean;
  workflowAdapter: boolean;
}

export function resolveStartupSecurity(input: {
  argv: string[];
  globalPolicy?: PolicyLevel;
  projectPolicy?: PolicyLevel;
}): StartupSecuritySnapshot {
  const recovery = input.argv.includes("--recovery");
  const trustedProject = !recovery && input.argv.includes("--trust-project");
  const cliPolicy = parsePolicy(input.argv);
  const policy = resolveEffectivePolicy({
    ...(cliPolicy ? { cliPolicy } : {}),
    ...(input.globalPolicy ? { globalPolicy: input.globalPolicy } : {}),
    ...(trustedProject && input.projectPolicy ? { projectPolicy: input.projectPolicy } : {}),
    recovery,
  });
  return {
    recovery,
    policy: policy.policy,
    boundary: policy.boundary,
    trustedProject,
    resourceScope: recovery ? "global-only" : "workspace",
    projectSettings: trustedProject,
    extensions: !recovery,
    workflowAdapter: !recovery,
  };
}

function parsePolicy(argv: string[]): PolicyLevel | undefined {
  const equals = argv.find((value) => value.startsWith("--policy="))?.slice("--policy=".length);
  const flag = argv.indexOf("--policy");
  const candidate = equals ?? (flag >= 0 ? argv[flag + 1] : undefined);
  if (!candidate) return undefined;
  const normalized = candidate.toLowerCase();
  if (normalized === "safe") return "Safe";
  if (normalized === "standard") return "Standard";
  if (normalized === "auto") return "Auto";
  if (normalized === "yolo") return "YOLO";
  throw new Error(`--policy 只允许 Safe、Standard、Auto、YOLO；收到 ${candidate}`);
}
