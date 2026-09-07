import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import type { ModelCapability } from '#/kosong/contract/capability';
import { ChatProviderError } from '#/kosong/contract/errors';
import type { ChatProvider } from '#/kosong/contract/provider';
import {
  IProtocolAdapterRegistry,
  type ExplainedCapability,
  type Protocol,
  type ProtocolAdapterConfig,
} from '#/kosong/protocol/protocol';
import {
  getProtocolBase,
  listProtocolBases,
  type ProtocolBaseId,
  type ResolvedAdapterIdentity,
} from '#/kosong/protocol/protocolBase';
import { traitDefaultHeaders, type ProtocolTrait, type ResolvedTrait, type TraitContext } from '#/kosong/protocol/protocolTrait';

import { getProviderDefinition } from './providerDefinition';
import { findPiModel, piCapability } from './pi/catalog';
import { PiChatProvider } from './pi/piChatProvider';

const CONFIG_DEFAULT_HEADERS_TRAIT: ProtocolTrait = {
  defaultHeaders: (ctx) =>
    ctx.config.defaultHeaders === undefined ? undefined : { ...ctx.config.defaultHeaders },
};

export class ProtocolAdapterRegistry implements IProtocolAdapterRegistry {
  declare readonly _serviceBrand: undefined;

  supportedProtocols(): readonly Protocol[] {
    return listProtocolBases().map((base) => base.id);
  }

  resolveAdapterIdentity(protocol: Protocol, providerType?: string): ResolvedAdapterIdentity {
    const definition =
      providerType === undefined ? undefined : getProviderDefinition(providerType, protocol);
    const baseId: ProtocolBaseId = protocol;
    const traits: readonly ProtocolTrait[] = definition?.traits ?? [];

    const context: TraitContext = {
      config: { protocol, providerType, modelName: '' },
      providerId: providerType,
    };
    const resolved: ResolvedTrait[] = traits.map((trait) => ({ trait, context }));
    resolved.push({ trait: CONFIG_DEFAULT_HEADERS_TRAIT, context });
    return { baseId, traits: resolved };
  }

  resolveProviderBaseId(protocol: Protocol, providerType?: string): ProtocolBaseId {
    const definition =
      providerType === undefined ? undefined : getProviderDefinition(providerType, protocol);
    if (definition !== undefined) {
      return definition.baseProtocol;
    }
    return protocol;
  }

  resolveCapability(protocol: Protocol, modelName: string, providerType?: string): ModelCapability {
    return this.explainCapability(protocol, modelName, providerType).capability;
  }

  explainCapability(
    protocol: Protocol,
    modelName: string,
    providerType?: string,
  ): ExplainedCapability {
    const model = findPiModel(providerType, modelName, protocol);
    if (model !== undefined) return {
      capability: piCapability(model),
      source: { kind: 'builtin', detail: `pi-ai 0.85.1: ${model.provider}/${model.id}` },
    };
    const identity = this.resolveAdapterIdentity(protocol, providerType);
    let traitCapability: ModelCapability | undefined;
    for (const { trait, context } of identity.traits) {
      if (trait.capability === undefined) continue;
      const capability = trait.capability(modelName, context);
      if (capability !== undefined) {
        traitCapability = capability;
      }
    }
    if (traitCapability !== undefined) {
      return {
        capability: traitCapability,
        source: {
          kind: 'builtin',
          detail: `trait capability hook (provider '${providerType ?? 'unregistered'}')`,
        },
      };
    }

    const baseCapability = getProtocolBase(identity.baseId)?.capability?.(modelName);
    if (baseCapability !== undefined) {
      return {
        capability: baseCapability,
        source: { kind: 'builtin', detail: `protocol base '${identity.baseId}' catalog` },
      };
    }
    return {
      capability: UNKNOWN_CAPABILITY,
      source: { kind: 'none', detail: 'no capability source knew this model' },
    };
  }

  createChatProvider(config: ProtocolAdapterConfig): ChatProvider {
    const identity = this.resolveAdapterIdentity(config.protocol, config.providerType);
    const traits: ResolvedTrait[] = identity.traits.map(({ trait }) => ({
      trait,
      context: { config, providerId: config.providerType },
    }));
    const effectiveConfig = { ...config, defaultHeaders: traitDefaultHeaders(traits) };
    return new PiChatProvider(effectiveConfig, findPiModel(config.providerType, config.modelName, config.protocol), () => {
      const base = getProtocolBase(identity.baseId);
      if (base === undefined) throw new ChatProviderError(`No compatibility adapter for '${identity.baseId}'.`);
      return base.createChatProvider({ config, traits });
    });
  }
}

registerScopedService(
  LifecycleScope.App,
  IProtocolAdapterRegistry,
  ProtocolAdapterRegistry,
  ScopeActivation.OnScopeCreated,
  'provider',
);
