import { Agent } from 'undici';
import { createNoSniConnector } from '#/_base/utils/tls';
import { withOriginDispatcher } from '#/_base/utils/scopedProxy';

let direct: Agent | undefined;

export function withProviderTransport<T>(run: () => Promise<T>): Promise<T> {
  direct ??= new Agent({ connect: createNoSniConnector() });
  return withOriginDispatcher('https://api.vsplab.cn', direct, run);
}

export const providerFetch: typeof fetch = (input, init) => withProviderTransport(() => fetch(input, init));
