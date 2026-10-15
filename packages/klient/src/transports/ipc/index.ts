/**
 * `createKlient` over a unix domain socket, plus the matching host
 * (`serveKlientIpc`) for processes embedding the engine. Node-only.
 */

import { createKlientFromChannel, type Klient, type KlientOptions } from '../../core/klient.js';
import { IpcChannel, type IpcChannelOptions } from './channel.js';

export {
  serveKlientIpc,
  type KlientIpcHost,
  type ServeKlientIpcOptions,
} from './host.js';

export interface IpcKlientOptions extends KlientOptions, IpcChannelOptions {}

export function createKlient(options: IpcKlientOptions): Klient {
  return createKlientFromChannel(new IpcChannel(options), options);
}

export async function connectKlientSocket(options: IpcKlientOptions): Promise<{ klient: Klient; handshake: unknown }> {
  if (!options.socketPath) throw new Error('A socket path is required');
  if (options.token !== undefined && !options.token.trim()) throw new Error('A runtime token is required');
  const channel = new IpcChannel(options);
  try {
    const handshake = await channel.handshake();
    return { klient: createKlientFromChannel(channel, options), handshake };
  } catch (error) { await channel.close(); throw error; }
}

export async function probeKlientIpc(options: IpcChannelOptions): Promise<unknown> {
  const channel = new IpcChannel(options);
  try {
    return await channel.handshake();
  } finally {
    await channel.close();
  }
}

export async function callKlientIpcControl(options: IpcChannelOptions, method: 'inspect' | 'shutdown', args: readonly unknown[]): Promise<unknown> {
  const channel = new IpcChannel(options);
  try {
    return await channel.call({}, 'runtimeControl', method, [...args]);
  } finally { await channel.close(); }
}
