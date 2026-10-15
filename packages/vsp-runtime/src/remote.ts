import type { Klient } from '@moonshot-ai/klient';
import { connectKlient } from '@moonshot-ai/klient/tcp';

import { VSP_RUNTIME_PROTOCOL_VERSION } from './types.js';

export interface RemoteRuntimeOptions {
  readonly port: number;
  readonly token: string;
  readonly runtimeId: string;
  readonly version: string;
  readonly callTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
}

export interface RemoteRuntimeConnection {
  readonly runtimeId: string;
  readonly klient: Klient;
  close(): Promise<void>;
}

export async function connectRemoteRuntime(options: RemoteRuntimeOptions): Promise<RemoteRuntimeConnection> {
  const { klient, handshake } = await connectKlient({
    port: options.port,
    token: options.token,
    callTimeoutMs: options.callTimeoutMs,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
  });
  try {
    assertCompatibleRemoteHandshake(handshake, options);
  } catch (error) {
    await klient.close();
    throw error;
  }
  return { runtimeId: options.runtimeId, klient, close: () => klient.close() };
}

function assertCompatibleRemoteHandshake(handshake: unknown, options: RemoteRuntimeOptions): void {
  if (typeof handshake !== 'object' || handshake === null) throw incompatibleRemoteRuntime();
  const record = handshake as Record<string, unknown>;
  const capabilities = record['capabilities'];
  if (
    record['runtimeId'] !== options.runtimeId ||
    record['version'] !== options.version ||
    record['protocolVersion'] !== VSP_RUNTIME_PROTOCOL_VERSION ||
    record['desktopProtocol'] !== 1 ||
    !Array.isArray(capabilities) ||
    !capabilities.includes('klient-tunnel-v1')
  ) throw incompatibleRemoteRuntime();
}

function incompatibleRemoteRuntime(): Error {
  return new Error('Remote VSP runtime is not compatible with this client');
}
