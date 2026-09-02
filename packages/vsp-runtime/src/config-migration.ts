import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parse, stringify } from 'smol-toml';

import {
  migrateLegacyVspiProviders,
  type LegacyProviderMigrationOptions,
} from './legacy-provider-compat.js';
import { resolveRuntimePaths } from './paths.js';
import type { ThinkingEffortRepairReason } from './thinking-effort-repair.js';

const MIGRATION_VERSION = 1;

interface ConfigMigrationMarker {
  readonly version: number;
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly completedAt: string;
}

export interface ConfigMigrationEffortRepairAction {
  readonly status: 'applied' | 'preserved';
  readonly reason: ThinkingEffortRepairReason;
  readonly changed: boolean;
}

export interface ConfigMigrationReport {
  readonly version: number;
  readonly status: 'migrated' | 'repaired';
  readonly completedAt: string;
  readonly sourceFingerprint: string;
  readonly beforeExisted: boolean;
  readonly beforeFingerprint: string;
  readonly targetFingerprint: string;
  readonly backupPath: string;
  readonly providers: number;
  readonly models: number;
  readonly defaultModel: boolean;
  readonly thinking: boolean;
  readonly repairedDefaultModel: boolean;
  readonly effortRepair?: ConfigMigrationEffortRepairAction;
  readonly diagnostics: readonly string[];
}

export interface ConfigMigrationFaultInjector {
  reach(stage: 'after-target-write' | 'after-report-write' | 'after-marker-write'): void | Promise<void>;
}

export interface MigrateRuntimeConfigOptions extends LegacyProviderMigrationOptions {
  readonly homeDir?: string;
  readonly now?: () => Date;
  readonly faultInjector?: ConfigMigrationFaultInjector;
}

export type RuntimeMigrationWarningReason =
  | 'bad-toml'
  | 'effort-repair'
  | 'default-model-repair'
  | 'legacy-migration';

export interface RuntimeMigrationWarning {
  readonly status: 'migrated' | 'repaired';
  readonly reason: RuntimeMigrationWarningReason;
}

export interface RuntimeConfigMigrationResult {
  readonly status: 'unchanged' | 'migrated' | 'repaired';
  readonly targetFingerprint: string;
  readonly report?: ConfigMigrationReport;
  readonly warning?: RuntimeMigrationWarning;
}

export async function migrateRuntimeConfig(
  options: MigrateRuntimeConfigOptions = {},
): Promise<RuntimeConfigMigrationResult> {
  const paths = resolveRuntimePaths(options.homeDir);
  await mkdir(paths.homeDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.serverDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.configMigrationBackupDir, { recursive: true, mode: 0o700 });
  await chmod(paths.homeDir, 0o700);
  await chmod(paths.serverDir, 0o700);
  await chmod(paths.configMigrationBackupDir, 0o700);
  await recoverInterruptedMigration(paths);

  const original = await readOptional(paths.configPath);
  const originalMarker = await readOptional(paths.configMigrationMarkerPath);
  const originalReport = await readOptional(paths.configMigrationReportPath);
  const beforeFingerprint = fingerprint(original ?? Buffer.alloc(0));
  const backupPath = configBackupPath(paths.configMigrationBackupDir, beforeFingerprint);
  let target: Record<string, unknown>;
  let repaired = false;
  if (original === undefined) {
    target = {};
  } else {
    try {
      target = parse(original.toString('utf8')) as Record<string, unknown>;
    } catch {
      target = {};
      repaired = true;
    }
  }
  const migration = await migrateLegacyVspiProviders(target, options);
  const targetBytes = Buffer.from(`${stringify(migration.config)}\n`);
  const targetFingerprint = fingerprint(targetBytes);
  const marker = parseMarker(originalMarker);
  const report = parseReport(originalReport);
  if (
    !repaired && original !== undefined && original.equals(targetBytes) &&
    completionMatches(marker, report, migration.sourceFingerprint, targetFingerprint)
  ) {
    return { status: 'unchanged', targetFingerprint };
  }

  const targetChanged = repaired || original === undefined || !original.equals(targetBytes);
  await persistImmutableBackup(backupPath, original ?? Buffer.alloc(0));
  let targetWritten = false;
  let committed = false;
  try {
    if (targetChanged) {
      await atomicWrite(paths.configPath, targetBytes);
      targetWritten = true;
      await options.faultInjector?.reach('after-target-write');
    }
    const verified = await readFile(paths.configPath);
    if (fingerprint(verified) !== targetFingerprint) throw new Error('config migration verification fingerprint mismatch');
    parse(verified.toString('utf8'));
    const completionReport = await writeCompletionFiles(
      paths,
      migration,
      original !== undefined,
      beforeFingerprint,
      backupPath,
      targetFingerprint,
      options,
      repaired,
    );
    committed = true;
    await options.faultInjector?.reach('after-marker-write');
    const status = repaired ? 'repaired' : targetChanged ? 'migrated' : 'unchanged';
    return {
      status,
      targetFingerprint,
      report: completionReport,
      warning: migrationWarning(status, repaired, migration),
    };
  } catch (error) {
    if (committed) throw error;
    const rollbackErrors: unknown[] = [];
    if (targetWritten) {
      await restoreOptional(paths.configPath, original).catch((rollbackError: unknown) => rollbackErrors.push(rollbackError));
    }
    await restoreOptional(paths.configMigrationReportPath, originalReport)
      .catch((rollbackError: unknown) => rollbackErrors.push(rollbackError));
    await restoreOptional(paths.configMigrationMarkerPath, originalMarker)
      .catch((rollbackError: unknown) => rollbackErrors.push(rollbackError));
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'config migration failed and rollback was incomplete');
    }
    throw error;
  }
}

async function writeCompletionFiles(
  paths: ReturnType<typeof resolveRuntimePaths>,
  migration: Awaited<ReturnType<typeof migrateLegacyVspiProviders>>,
  beforeExisted: boolean,
  beforeFingerprint: string,
  backupPath: string,
  targetFingerprint: string,
  options: MigrateRuntimeConfigOptions,
  repaired: boolean,
): Promise<ConfigMigrationReport> {
  const completedAt = (options.now?.() ?? new Date()).toISOString();
  const report: ConfigMigrationReport = {
    version: MIGRATION_VERSION,
    status: repaired ? 'repaired' : 'migrated',
    completedAt,
    sourceFingerprint: migration.sourceFingerprint,
    beforeExisted,
    beforeFingerprint,
    targetFingerprint,
    backupPath,
    providers: migration.providers,
    models: migration.models,
    defaultModel: migration.defaultModel,
    thinking: migration.thinking,
    repairedDefaultModel: migration.repairedDefaultModel,
    effortRepair: migration.effortRepair === undefined ? undefined : {
      status: migration.effortRepair.status,
      reason: migration.effortRepair.reason,
      changed: migration.effortRepair.before !== migration.effortRepair.after,
    },
    diagnostics: migration.diagnostics.map(redactDiagnostic),
  };
  const marker: ConfigMigrationMarker = {
    version: MIGRATION_VERSION,
    sourceFingerprint: migration.sourceFingerprint,
    targetFingerprint,
    completedAt,
  };
  await atomicWrite(paths.configMigrationReportPath, Buffer.from(`${JSON.stringify(report, null, 2)}\n`));
  await options.faultInjector?.reach('after-report-write');
  await atomicWrite(paths.configMigrationMarkerPath, Buffer.from(`${JSON.stringify(marker, null, 2)}\n`));
  return report;
}

async function recoverInterruptedMigration(paths: ReturnType<typeof resolveRuntimePaths>): Promise<void> {
  const [target, markerBytes, reportBytes] = await Promise.all([
    readOptional(paths.configPath),
    readOptional(paths.configMigrationMarkerPath),
    readOptional(paths.configMigrationReportPath),
  ]);
  const report = parseReport(reportBytes);
  if (report === undefined) return;
  const marker = parseMarker(markerBytes);
  if (completionMatches(marker, report, report.sourceFingerprint, report.targetFingerprint)) return;
  if (target === undefined || fingerprint(target) !== report.targetFingerprint) return;
  const expectedBackupPath = configBackupPath(paths.configMigrationBackupDir, report.beforeFingerprint);
  if (report.backupPath !== expectedBackupPath) throw new Error('config migration report references an invalid backup path');
  const backup = await readFile(expectedBackupPath);
  if (fingerprint(backup) !== report.beforeFingerprint) throw new Error('config migration backup fingerprint mismatch');
  await restoreOptional(paths.configPath, report.beforeExisted ? backup : undefined);
  await rm(paths.configMigrationReportPath, { force: true });
  await syncDirectory(paths.serverDir);
}

async function persistImmutableBackup(path: string, payload: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const existing = await readOptional(path);
  if (existing !== undefined) {
    if (!existing.equals(payload)) throw new Error('config migration immutable backup content mismatch');
    return;
  }
  const temporaryPath = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporaryPath, path);
      await syncDirectory(dirname(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raced = await readFile(path);
      if (!raced.equals(payload)) throw new Error('config migration immutable backup content mismatch');
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true });
  }
}

function configBackupPath(backupDir: string, beforeFingerprint: string): string {
  return join(backupDir, `config.${beforeFingerprint}.backup`);
}

async function restoreOptional(path: string, value: Buffer | undefined): Promise<void> {
  if (value === undefined) {
    await rm(path, { force: true });
    return;
  }
  await atomicWrite(path, value);
}

async function atomicWrite(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let handle: FileHandle | undefined;
  let completed = false;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    await syncDirectory(dirname(path));
    completed = true;
  } finally {
    await handle?.close().catch(() => {});
    if (!completed) await rm(temporaryPath, { force: true });
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseMarker(value: Buffer | undefined): ConfigMigrationMarker | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Partial<ConfigMigrationMarker>;
    if (
      parsed.version !== MIGRATION_VERSION || typeof parsed.sourceFingerprint !== 'string' ||
      typeof parsed.targetFingerprint !== 'string' || typeof parsed.completedAt !== 'string'
    ) return undefined;
    return parsed as ConfigMigrationMarker;
  } catch {
    return undefined;
  }
}

function parseReport(value: Buffer | undefined): ConfigMigrationReport | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Partial<ConfigMigrationReport>;
    if (
      parsed.version !== MIGRATION_VERSION || (parsed.status !== 'migrated' && parsed.status !== 'repaired') ||
      typeof parsed.completedAt !== 'string' || typeof parsed.sourceFingerprint !== 'string' ||
      typeof parsed.beforeExisted !== 'boolean' || typeof parsed.beforeFingerprint !== 'string' ||
      typeof parsed.targetFingerprint !== 'string' || typeof parsed.backupPath !== 'string'
    ) return undefined;
    return parsed as ConfigMigrationReport;
  } catch {
    return undefined;
  }
}

function completionMatches(
  marker: ConfigMigrationMarker | undefined,
  report: ConfigMigrationReport | undefined,
  sourceFingerprint: string,
  targetFingerprint: string,
): boolean {
  return marker?.version === MIGRATION_VERSION && report?.version === MIGRATION_VERSION &&
    marker.sourceFingerprint === sourceFingerprint && report.sourceFingerprint === sourceFingerprint &&
    marker.targetFingerprint === targetFingerprint && report.targetFingerprint === targetFingerprint &&
    marker.completedAt === report.completedAt;
}

function fingerprint(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function parseRuntimeMigrationWarning(value: unknown): RuntimeMigrationWarning | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const warning = value as Record<string, unknown>;
  const status = warning['status'];
  const reason = warning['reason'];
  if (status !== 'migrated' && status !== 'repaired') return undefined;
  if (
    reason !== 'bad-toml' && reason !== 'effort-repair' &&
    reason !== 'default-model-repair' && reason !== 'legacy-migration'
  ) return undefined;
  return { status, reason };
}

function migrationWarning(
  status: RuntimeConfigMigrationResult['status'],
  badToml: boolean,
  migration: Awaited<ReturnType<typeof migrateLegacyVspiProviders>>,
): RuntimeMigrationWarning | undefined {
  if (badToml) return { status: 'repaired', reason: 'bad-toml' };
  if (migration.effortRepair !== undefined && migration.effortRepair.before !== migration.effortRepair.after) {
    return { status: 'repaired', reason: 'effort-repair' };
  }
  if (migration.repairedDefaultModel) return { status: 'repaired', reason: 'default-model-repair' };
  if (status === 'migrated' && (migration.providers > 0 || migration.models > 0 || migration.defaultModel || migration.thinking)) {
    return { status: 'migrated', reason: 'legacy-migration' };
  }
  return undefined;
}

function redactDiagnostic(value: string): string {
  return value
    .replaceAll(/(api[_-]?key|token|authorization|secret)\s*[=:]\s*[^\s,;]+/giu, '$1=[REDACTED]')
    .replaceAll(/Bearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]');
}
