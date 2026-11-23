/**
 * `providerDiscovery` — the engine's `IProviderDiscoveryService`: remote
 * provider-model discovery and config sync. Mirrors
 * `agent-core-v2/app/kosongConfig/discovery.ts`.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const refreshProviderModelsOptionsSchema = z.object({
  scope: z.enum(['all', 'oauth']).optional(),
  providerId: z.string().optional(),
});

/** Same shape as `refreshOAuthProviderModelsResponseSchema` in `./auth.js` — keep in sync. */
export const refreshProviderModelsResponseSchema = z.object({
  changed: z.array(
    z.object({
      provider_id: z.string(),
      provider_name: z.string(),
      added: z.number(),
      removed: z.number(),
    }),
  ),
  unchanged: z.array(z.string()),
  failed: z.array(z.object({ provider: z.string(), reason: z.string() })),
});

export const queryAvailableModelsResponseSchema = z.object({
  providerId: z.string().min(1),
  modelIds: z.array(z.string().min(1)),
});

export const providerConnectivityTestResultSchema = z.object({
  ok: z.boolean(),
  providerId: z.string(),
  category: z.enum(['ok', 'config_error', 'auth_error', 'network_error', 'timeout', 'protocol_error', 'unknown_error']),
  durationMs: z.number().nonnegative(),
  httpStatus: z.number().int().optional(),
  modelCount: z.number().int().nonnegative().optional(),
  probeKind: z.enum(['models', 'balance', 'account', 'offline']).optional(),
  diagnostic: z.string(),
});

export const providerDiscoveryContract = {
  testProvider: {
    input: z.tuple([z.string().min(1)]),
    output: providerConnectivityTestResultSchema,
  },
  refreshProviderModels: {
    input: z.tuple([refreshProviderModelsOptionsSchema.optional()]),
    output: refreshProviderModelsResponseSchema,
  },
  queryAvailableModels: {
    input: z.tuple([z.string().min(1)]),
    output: queryAvailableModelsResponseSchema,
  },
} satisfies ServiceContract;
