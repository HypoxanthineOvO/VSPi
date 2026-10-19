import { z } from 'zod';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { errorStatusCode } from '#human/llm/errors';

export const modelHealthSchema = z.object({
  lastSuccess: z.number().nonnegative().optional(),
  lastFailure: z.object({
    at: z.number().nonnegative(),
    category: z.enum(['auth', 'not_found', 'rate_limit', 'network', 'other']),
  }).optional(),
  expiresAt: z.number().nonnegative(),
});
export type ModelHealth = z.infer<typeof modelHealthSchema>;

export interface IModelHealth {
  readonly _serviceBrand: undefined;
  get(provider: string, model: string): ModelHealth | undefined;
  record(provider: string, model: string, error?: unknown): void;
}
export const IModelHealth: ServiceIdentifier<IModelHealth> = createDecorator<IModelHealth>('modelHealth');

export function modelHealthFailure(error: unknown): NonNullable<ModelHealth['lastFailure']>['category'] {
  const status = errorStatusCode(error);
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (error instanceof TypeError || (error instanceof Error && /network|connection|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|timeout/iu.test(`${error.name} ${error.message}`))) return 'network';
  return 'other';
}

export class ModelHealthStore implements IModelHealth {
  declare readonly _serviceBrand: undefined;
  protected readonly records = new Map<string, ModelHealth>();

  get(provider: string, model: string): ModelHealth | undefined {
    const health = this.records.get(JSON.stringify([provider, model]));
    return health === undefined ? undefined : structuredClone(health);
  }

  record(provider: string, model: string, error?: unknown): void {
    const key = JSON.stringify([provider, model]);
    const previous = this.records.get(key);
    const now = Math.max(Date.now(), (previous?.lastSuccess ?? 0) + 1, (previous?.lastFailure?.at ?? 0) + 1);
    const category = error === undefined ? undefined : modelHealthFailure(error);
    const ttl = category === 'auth' || category === 'not_found' ? 24 * 60 * 60_000 : category === 'rate_limit' ? 5 * 60_000 : category === 'network' ? 2 * 60_000 : category === 'other' ? 10 * 60_000 : 60 * 60_000;
    this.records.delete(key);
    this.records.set(key, {
      lastSuccess: error === undefined ? now : previous?.lastSuccess,
      lastFailure: category === undefined ? previous?.lastFailure : { at: now, category },
      expiresAt: now + ttl,
    });
    while (this.records.size > 2000) this.records.delete(this.records.keys().next().value!);
    if (category !== undefined || previous?.lastFailure !== undefined || now - (previous?.lastSuccess ?? 0) >= 60_000) this.save();
  }

  protected save(): void {}
}
