import { createDecorator } from '#/_base/di/instantiation';

export interface IModelRequestNetwork {
  readonly _serviceBrand: undefined;
  proxyForUrl(url: string | undefined, providerType?: string, fallback?: string): string | undefined;
}

export const IModelRequestNetwork = createDecorator<IModelRequestNetwork>('modelRequestNetwork');
