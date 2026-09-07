export interface ModelIdentity {
  provider: string;
  model: string;
}

export type ProfileSourceType = "factory" | "user-fork" | "global" | "project" | "session";
export type EvaluationStatus = "unreviewed" | "reviewed" | "verified";

export interface PromptProfile {
  id: string;
  name: string;
  family: string;
  sourceType: ProfileSourceType;
  evaluationStatus: EvaluationStatus;
  segments: { profile: string };
  immutable: boolean;
  origin?: {
    profileId?: string;
    revision?: string;
    sourceUrl?: string;
    ref?: string;
    licensePolicy?: string;
  };
}

export interface PromptProfileRule {
  id: string;
  profileId: string;
  enabled: boolean;
  match: { provider?: string; model?: string; family?: string };
}

export interface PromptProfileConfig {
  schemaVersion: 1;
  source: "vspi.prompt-profile";
  profiles: PromptProfile[];
  rules: PromptProfileRule[];
  pin?: string;
  disabled?: boolean;
}

export interface PromptProfileSnapshot {
  profiles: PromptProfile[];
  rules: PromptProfileRule[];
  global: PromptProfileConfig;
  project?: PromptProfileConfig;
  session?: PromptProfileConfig;
  hashes: { global: string; project?: string; session?: string };
  hash: string;
  diagnostics: Array<{ path: string; message: string }>;
}

export interface ResolvedPromptProfile {
  profile?: PromptProfile;
  profileId?: string;
  overlay?: string;
  scope: "off" | "session" | "project" | "global" | "factory";
  ruleId?: string;
  matchedRuleId?: string;
}
