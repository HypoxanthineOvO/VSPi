import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type ProviderQuotaMode =
  | 'off'
  | 'auto'
  | 'newapi-token'
  | 'newapi-account'
  | 'cpa';

export type ProviderQuotaApiProfile = 'v8' | 'v0-compat' | 'account' | 'token';

export type ProviderQuotaRegion = 'cn' | 'global';

export interface ProviderQuotaConfig {
  mode?: ProviderQuotaMode;
  apiProfile?: ProviderQuotaApiProfile;
  managementUrl?: string;
  managementKey?: string;
  managementKeyEnv?: string;
  managementKeyRef?: string;
  userId?: string;
  billingMultiplier?: number;
  region?: ProviderQuotaRegion;
  accountFilter?: string[];
}

export type QuotaReadingStatus =
  | 'ok'
  | 'stale'
  | 'auth_error'
  | 'network_error'
  | 'unconfigured';

export type QuotaErrorReason =
  | 'auth_expired'
  | 'forbidden'
  | 'rate_limited'
  | 'timeout'
  | 'schema_mismatch'
  | 'unsupported'
  | 'disabled'
  | 'no_credential'
  | 'account_unmatched';

export type QuotaCategory = 'subscription' | 'cpa' | 'balance';

export interface QuotaWindowItem {
  id: string;
  label: string;
  remainingPercent: number;
  resetsInMs?: number;
  resetAt?: number;
  modelIds?: string[];
  stale?: boolean;
}

export interface QuotaBalanceItem {
  id: string;
  label?: string;
  currency: string;
  amount: number;
  limit?: number;
  multiplier?: number;
  equivalentAmount?: number;
  unlimited?: boolean;
  stale?: boolean;
}

export interface ProviderQuotaItem {
  id: string;
  providerId: string;
  providerLabel?: string;
  accountLabel?: string;
  upstream?: string;
  category: QuotaCategory;
  status: QuotaReadingStatus;
  errorReason?: QuotaErrorReason;
  errorMessage?: string;
  windows: QuotaWindowItem[];
  balances: QuotaBalanceItem[];
  updatedAt: number | null;
  checkedAt: number;
  stale: boolean;
  freshUntil?: number;
  staleUntil?: number;
}

export interface QuotaQueryOptions {
  providerId?: string;
  includeDisabled?: boolean;
}

export interface QuotaRefreshOptions {
  providerId?: string;
}

export interface QuotaSnapshotResponse {
  items: ProviderQuotaItem[];
  now: number;
  revision: number;
  cooldownRemainingMs?: number;
}

export interface IQuotaService {
  readonly _serviceBrand: undefined;

  getQuotas(options?: QuotaQueryOptions): Promise<QuotaSnapshotResponse>;
  refreshQuotas(options?: QuotaRefreshOptions): Promise<QuotaSnapshotResponse>;
}

export const IQuotaService: ServiceIdentifier<IQuotaService> =
  createDecorator<IQuotaService>('quotaService');
