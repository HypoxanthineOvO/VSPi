import type { ThinkingCapabilityInput } from '#/llm-adapter/contract/capability';
import type { Protocol } from '#/llm-adapter/protocol/protocol';
import type { CanonicalModel } from './canonical';
import type { ModelPricing } from './model';

export interface ModelMetadataLookupOptions {
  readonly providerType?: string;
  readonly protocol?: Protocol;
  readonly allowRelayFallback?: boolean;
}

export interface BuiltinModelMetadata {
  readonly canonical: CanonicalModel;
  readonly modelId: string;
  readonly displayName: string;
  readonly maxContextSize: number;
  readonly maxOutputSize?: number;
  readonly capabilities: readonly string[];
  readonly thinking: ThinkingCapabilityInput;
  readonly defaultProtocol?: Protocol;
  readonly pricing?: ModelPricing;
  readonly pricingSource?: 'official' | 'provider';
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly effortMapping?: Readonly<Record<string, string | null>>;
  readonly effortProfileRevision?: number;
  readonly adaptiveThinking?: boolean;
  readonly source: 'pi-catalog' | 'vsplab-catalog' | 'effort-profile';
}

export type LookupBuiltinModelMetadata = (
  modelId: string,
  options?: ModelMetadataLookupOptions,
) => BuiltinModelMetadata | undefined;
