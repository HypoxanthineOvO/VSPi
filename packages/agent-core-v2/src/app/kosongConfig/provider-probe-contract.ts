export type ProviderConnectivityCategory =
  | 'ok'
  | 'config_error'
  | 'auth_error'
  | 'network_error'
  | 'timeout'
  | 'protocol_error'
  | 'unknown_error';

export type ProviderConnectivityProbeKind = 'models' | 'balance' | 'account' | 'offline';

export interface ProviderConnectivityTestResult {
  ok: boolean;
  providerId: string;
  category: ProviderConnectivityCategory;
  durationMs: number;
  httpStatus?: number;
  modelCount?: number;
  probeKind?: ProviderConnectivityProbeKind;
  diagnostic: string;
}
