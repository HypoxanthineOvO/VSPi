import { z } from 'zod';
import type { ServiceContract } from '../types.js';

const milliseconds = z.number().nonnegative();
const providerId = z.string().min(1).optional();
export const quotaQueryOptionsSchema = z.object({ providerId, includeDisabled: z.boolean().optional() });
export const quotaRefreshOptionsSchema = z.object({ providerId });

const windowSchema = z.object({
  id: z.string().min(1), label: z.string(), remainingPercent: z.number().min(0).max(100),
  resetsInMs: milliseconds.optional(), resetAt: milliseconds.optional(),
  modelIds: z.array(z.string()).optional(), stale: z.boolean().optional(),
});

const balanceSchema = z.object({
  id: z.string().min(1), label: z.string().optional(), currency: z.string().min(1), amount: z.number(),
  limit: z.number().optional(), multiplier: z.number().positive().optional(), equivalentAmount: z.number().optional(),
  unlimited: z.boolean().optional(), stale: z.boolean().optional(),
});

const providerQuotaSchema = z.object({
  id: z.string().min(1), providerId: z.string().min(1), providerLabel: z.string().optional(),
  accountLabel: z.string().optional(), upstream: z.string().optional(),
  category: z.enum(['subscription', 'cpa', 'balance']),
  status: z.enum(['ok', 'stale', 'auth_error', 'network_error', 'unconfigured']),
  errorReason: z.enum(['auth_expired', 'forbidden', 'rate_limited', 'timeout', 'schema_mismatch', 'unsupported', 'disabled', 'no_credential', 'account_unmatched']).optional(),
  errorMessage: z.string().optional(), windows: z.array(windowSchema), balances: z.array(balanceSchema),
  updatedAt: milliseconds.nullable(), checkedAt: milliseconds, stale: z.boolean(),
  freshUntil: milliseconds.optional(), staleUntil: milliseconds.optional(),
});

export const quotaSnapshotResponseSchema = z.object({
  items: z.array(providerQuotaSchema), now: milliseconds, revision: z.number().int().nonnegative(), cooldownRemainingMs: milliseconds.optional(),
});

export const quotaContract = {
  getQuotas: { input: z.tuple([quotaQueryOptionsSchema.optional()]), output: quotaSnapshotResponseSchema },
  refreshQuotas: { input: z.tuple([quotaRefreshOptionsSchema.optional()]), output: quotaSnapshotResponseSchema },
} satisfies ServiceContract;
