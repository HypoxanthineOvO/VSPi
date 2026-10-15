import { z } from 'zod';

import type { ServiceContract } from '../types.js';

const PROVIDER_ID_MAX_LENGTH = 128;
const PROVIDER_TYPE_MAX_LENGTH = 128;
const CREDENTIAL_VALUE_MAX_LENGTH = 16 * 1024;
const BASE_URL_MAX_LENGTH = 2048;
const DEFAULT_MODEL_MAX_LENGTH = 1024;
const MASK_ONLY_PATTERN = /^[*•●·∗＊]+$/u;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REVISION_PATTERN = /^[0-9a-f]{64}$/;
const FORBIDDEN_PROVIDER_IDS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  '__kimi_env__',
]);

export const desktopSettingsRevisionSchema = z.string().regex(REVISION_PATTERN);

export const desktopProviderIdSchema = z
  .string()
  .min(1)
  .max(PROVIDER_ID_MAX_LENGTH)
  .refine((id) => !FORBIDDEN_PROVIDER_IDS.has(id));

const credentialValueSchema = z
  .string()
  .max(CREDENTIAL_VALUE_MAX_LENGTH)
  .refine(
    (value) => value.trim().length > 0 && !MASK_ONLY_PATTERN.test(value.trim()),
  );

const baseUrlInputSchema = z
  .string()
  .max(BASE_URL_MAX_LENGTH)
  .refine((value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      return (
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === ''
      );
    } catch {
      return false;
    }
  });

export const credentialEditSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('replace'), value: credentialValueSchema }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
  z
    .object({ action: z.literal('environment'), name: z.string().regex(ENV_NAME_PATTERN) })
    .strict(),
]);

export const providerSettingsPatchSchema = z
  .object({
    type: z.string().min(1).max(PROVIDER_TYPE_MAX_LENGTH).optional(),
    baseUrl: z.union([baseUrlInputSchema, z.null()]).optional(),
    defaultModel: z
      .union([z.string().min(1).max(DEFAULT_MODEL_MAX_LENGTH), z.null()])
      .optional(),
    modelSource: z.enum(['static', 'discover', 'oauth-catalog']).optional(),
  })
  .strict();

export const providerSettingsEditSchema = z
  .object({
    revision: desktopSettingsRevisionSchema,
    id: desktopProviderIdSchema,
    patch: providerSettingsPatchSchema,
    credential: credentialEditSchema,
  })
  .strict();

export const providerRemoveSchema = z
  .object({
    revision: desktopSettingsRevisionSchema,
    id: desktopProviderIdSchema,
  })
  .strict();

export const desktopProviderSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  baseUrl: z.string().optional(),
  baseUrlRedacted: z.boolean(),
  defaultModel: z.string().optional(),
  modelSource: z.enum(['static', 'discover', 'oauth-catalog']).optional(),
  credential: z.object({
    kind: z.enum(['none', 'api-key', 'environment', 'oauth', 'conflict']),
    configured: z.boolean(),
    environment: z.string().optional(),
    resolved: z.boolean().optional(),
  }),
  customHeaderNames: z.array(z.string()),
  environmentNames: z.array(z.string()),
});

export const desktopSettingsDiagnosticSchema = z.object({
  domain: z.string().optional(),
  severity: z.enum(['warning', 'error']),
  message: z.string(),
});

export const desktopSettingsSnapshotSchema = z.object({
  revision: z.string(),
  homeDir: z.string(),
  scope: z.literal('runtime'),
  providers: z.array(desktopProviderSchema),
  defaultModel: z.string().optional(),
  defaultPermissionMode: z.enum(['auto', 'manual', 'yolo']).optional(),
  extraSkillDirs: z.array(z.string()),
  diagnostics: z.array(desktopSettingsDiagnosticSchema),
});

export const desktopSettingsSaveSchema = z.object({
  settings: desktopSettingsSnapshotSchema,
  effective: z.literal('next-request'),
});

export const settingsChangedSchema = z.object({ revision: z.string() });

export const desktopSettingsContract = {
  read: { input: z.tuple([]), output: desktopSettingsSnapshotSchema },
  saveProvider: {
    input: z.tuple([providerSettingsEditSchema]),
    output: desktopSettingsSaveSchema,
  },
  removeProvider: {
    input: z.tuple([providerRemoveSchema]),
    output: desktopSettingsSaveSchema,
  },
} satisfies ServiceContract;
