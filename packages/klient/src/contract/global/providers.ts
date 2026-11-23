/**
 * `providerService` — provider configuration registry. Mirrors
 * `agent-core-v2/llm-adapter/provider/provider.ts` (`ProviderConfigSchema`).
 * `type` is free-form text, not an enum: vendor identity is validated at
 * resolve time against the engine's provider-definition registry, so external
 * packages can register new vendors without touching this schema.
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

const providerTypeSchema = z.string();

const oAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});

const stringRecordSchema = z.record(z.string(), z.string());

const modelSourceSchema = z.enum(['static', 'discover', 'oauth-catalog']);

export const providerQuotaConfigSchema = z.object({
  mode: z.enum(['off', 'auto', 'newapi-token', 'newapi-account', 'cpa']).optional(),
  apiProfile: z.enum(['v8', 'v0-compat', 'account', 'token']).optional(),
  managementUrl: z.string().optional(),
  managementKey: z.string().optional(),
  managementKeyEnv: z.string().optional(),
  managementKeyRef: z.string().optional(),
  userId: z.string().optional(),
  billingMultiplier: z.number().positive().finite().optional(),
  region: z.enum(['cn', 'global']).optional(),
  accountFilter: z.array(z.string()).optional(),
});

export const providerConfigSchema = z.object({
  modelSource: modelSourceSchema.optional(),
  enabled: z.boolean().optional(),
  quota: providerQuotaConfigSchema.optional(),

  baseUrl: z.string().optional(),
  customHeaders: stringRecordSchema.optional(),
  defaultModel: z.string().optional(),

  type: providerTypeSchema.optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  oauth: oAuthRefSchema.optional(),
  env: stringRecordSchema.optional(),
  source: z.record(z.string(), z.unknown()).optional(),
});

const providerConfigViewSchema = providerConfigSchema.extend({
  quota: providerQuotaConfigSchema.omit({ managementKey: true, managementKeyRef: true }).extend({
    hasManagementKey: z.boolean().optional(),
    hasManagementKeyRef: z.boolean().optional(),
  }).optional(),
});

export const providersContract = {
  get: { input: z.tuple([z.string()]), output: maybe(providerConfigViewSchema) },
  list: { input: z.tuple([]), output: z.record(z.string(), providerConfigViewSchema) },
  set: { input: z.tuple([z.string(), providerConfigSchema]), output: noResult },
  delete: { input: z.tuple([z.string()]), output: noResult },
} satisfies ServiceContract;
