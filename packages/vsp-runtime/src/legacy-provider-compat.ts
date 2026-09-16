import { createHash } from 'node:crypto';
import { retireModelReferences } from './retired-models.js';
import { compactModelSnapshots } from './model-defaults.js';
import type { ThinkingEffortRepairAction } from './thinking-effort-repair.js';

export interface LegacyProviderMigrationOptions {
  readonly cleanProtocolDefaults?: boolean;
  readonly osHomeDir?: string;
  readonly agentDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface LegacyProviderMigrationResult {
  readonly config: Record<string, unknown>;
  readonly sourceFingerprint: string;
  readonly providers: number;
  readonly models: number;
  readonly defaultModel: boolean;
  readonly thinking: boolean;
  readonly repairedDefaultModel: boolean;
  readonly effortRepair?: ThinkingEffortRepairAction;
  readonly diagnostics: readonly string[];
}

export async function migrateLegacyVspiProviders(
  target: Readonly<Record<string, unknown>>,
  options: LegacyProviderMigrationOptions = {},
): Promise<LegacyProviderMigrationResult> {
  const config: Record<string, unknown> = structuredClone(target);
  const models = object(config['models']);
  const providers = object(config['providers']);
  const diagnostics: string[] = [];
  const renamed = retireModelReferences(config, models, providers, diagnostics);
  if (Object.keys(models).length) config['models'] = models;
  if (options.cleanProtocolDefaults !== false) compactModelSnapshots(config);
  return {
    config,
    sourceFingerprint: createHash('sha256').update('vspi-owned-config-v2').digest('hex'),
    providers: 0,
    models: renamed.size,
    defaultModel: config['default_model'] !== target['default_model'],
    thinking: false,
    repairedDefaultModel: false,
    diagnostics,
  };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
