import type { Klient, KlientEnvInfo } from '@moonshot-ai/klient';

import type { RuntimeMigrationWarning } from './config-migration.js';

export const VSP_RUNTIME_PROTOCOL_VERSION = 1;

export interface RuntimeHostIdentity {
  readonly productName: string;
  readonly version: string;
  readonly platform: string;
  readonly displayName?: string;
}

export interface RuntimeState {
  readonly protocolVersion: number;
  readonly pid: number;
  readonly ownerNonce: string;
  readonly host: string;
  readonly port: number;
  readonly ipcPath: string;
  readonly startedAt: string;
  readonly version: string;
  readonly migrationWarning?: RuntimeMigrationWarning;
}

export interface RuntimeConnection {
  readonly state: RuntimeState;
  readonly env: KlientEnvInfo;
  readonly migrationWarning?: RuntimeMigrationWarning;
  readonly klient: Klient;
  close(): Promise<void>;
}

export interface RuntimeDaemon {
  readonly state: RuntimeState;
  close(): Promise<void>;
}

export interface RuntimeSpawnRequest {
  readonly homeDir: string;
  readonly logPath: string;
}

export type RuntimeSpawner = (request: RuntimeSpawnRequest) => Promise<void> | void;
