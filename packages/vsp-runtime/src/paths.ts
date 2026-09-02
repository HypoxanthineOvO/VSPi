import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_HOME_NAME = '.vspi';

export interface RuntimePaths {
  readonly homeDir: string;
  readonly serverDir: string;
  readonly statePath: string;
  readonly leasePath: string;
  readonly ipcPath: string;
  readonly logPath: string;
  readonly tokenPath: string;
  readonly configPath: string;
  readonly configMigrationBackupDir: string;
  readonly configMigrationMarkerPath: string;
  readonly configMigrationReportPath: string;
}

export function resolveVspHome(homeDir?: string): string {
  return resolve(homeDir ?? process.env['VSPI_HOME'] ?? join(homedir(), DEFAULT_HOME_NAME));
}

export function resolveRuntimePaths(homeDir?: string): RuntimePaths {
  const resolvedHome = resolveVspHome(homeDir);
  const serverDir = join(resolvedHome, 'server');
  return {
    homeDir: resolvedHome,
    serverDir,
    statePath: join(serverDir, 'runtime.json'),
    leasePath: join(serverDir, 'runtime.lock'),
    ipcPath: resolveIpcPath(resolvedHome, serverDir),
    logPath: join(serverDir, 'runtime.log'),
    tokenPath: join(resolvedHome, 'server.token'),
    configPath: join(resolvedHome, 'config.toml'),
    configMigrationBackupDir: join(serverDir, 'config-migration-backups'),
    configMigrationMarkerPath: join(serverDir, 'config-migration.marker.json'),
    configMigrationReportPath: join(serverDir, 'config-migration.report.json'),
  };
}

function resolveIpcPath(homeDir: string, serverDir: string): string {
  const suffix = createHash('sha256').update(homeDir).digest('hex').slice(0, 16);
  if (process.platform === 'win32') return `\\\\.\\pipe\\vspi-${suffix}`;
  const preferred = join(serverDir, 'runtime.sock');
  if (Buffer.byteLength(preferred) <= 96) return preferred;
  return join(tmpdir(), `vspi-${suffix}.sock`);
}
