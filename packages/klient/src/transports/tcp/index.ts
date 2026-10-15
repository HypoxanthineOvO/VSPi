import { createConnection } from 'node:net';
import { createKlientFromChannel, type Klient, type KlientOptions } from '../../core/klient.js';
import { IpcChannel, type IpcChannelOptions } from '../ipc/channel.js';
import { DEFAULT_HANDSHAKE_TIMEOUT_MS, DEFAULT_MAX_FRAME_BYTES, positiveLimit } from '../ipc/codec.js';
export interface TcpKlientOptions extends KlientOptions, Omit<IpcChannelOptions, 'socketPath' | 'token'> {
  readonly port: number;
  readonly token: string;
}
export async function connectKlient(options: TcpKlientOptions): Promise<{ klient: Klient; handshake: unknown }> {
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid tunnel port');
  if (!options.token.trim()) throw new Error('A runtime token is required');
  positiveLimit(options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
  positiveLimit(options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);
  const channel = new IpcChannel({ ...options, socketPath: '' }, createConnection({ host: '127.0.0.1', port: options.port }));
  try {
    const handshake = await channel.handshake();
    return { klient: createKlientFromChannel(channel, options), handshake };
  } catch (error) { await channel.close(); throw error; }
}
