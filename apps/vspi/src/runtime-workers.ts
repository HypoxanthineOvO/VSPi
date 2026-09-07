import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { configureSearchWorkerRuntime } from '@moonshot-ai/kap-server/search-worker-runtime';
import { configureTextBuildWorkerRuntime } from '@moonshot-ai/minidb/worker-runtime';

export interface PackagedRuntimeAssets {
  readonly searchWorkerPath: string;
  readonly textBuildWorkerPath: string;
}

export function resolvePackagedRuntimeAssets(entryUrl: string | URL): PackagedRuntimeAssets | undefined {
  const searchWorkerPath = fileURLToPath(new URL('./search-worker.mjs', entryUrl));
  const textBuildWorkerPath = fileURLToPath(new URL('./text-build-worker.mjs', entryUrl));
  const searchExists = existsSync(searchWorkerPath);
  const textBuildExists = existsSync(textBuildWorkerPath);
  if (!searchExists && !textBuildExists) return undefined;
  if (!searchExists || !textBuildExists) {
    throw new Error('VSPi packaged runtime is incomplete: search-worker.mjs and text-build-worker.mjs must ship together');
  }
  return { searchWorkerPath, textBuildWorkerPath };
}

export function configurePackagedRuntimeWorkers(entryUrl: string | URL): PackagedRuntimeAssets | undefined {
  const assets = resolvePackagedRuntimeAssets(entryUrl);
  if (assets === undefined) return undefined;
  configureTextBuildWorkerRuntime(assets.textBuildWorkerPath);
  configureSearchWorkerRuntime(assets.searchWorkerPath);
  return assets;
}
