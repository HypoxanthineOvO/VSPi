import { errorStatusCode } from '#/llm/errors';
import type { LlmModel } from '#/llm/model';
import type { LlmRecovery } from '#/llm/requester/recovery';
import {
  mergeRequestHeaders,
  type LlmCredential,
  type LlmCredentialProvider,
} from '#/llm/requester/requester';

export interface AccessTokenResolver {
  (options?: { readonly force?: boolean }): Promise<string | undefined>;
}

export function createStaticCredentialProvider(apiKey?: string): LlmCredentialProvider {
  return {
    resolve: () =>
      apiKey === undefined || apiKey.trim().length === 0 ? undefined : { apiKey },
  };
}

export function createOAuthCredentialProvider(
  getToken: AccessTokenResolver,
): LlmCredentialProvider {
  let refreshed: Promise<string | undefined> | undefined;
  return {
    resolve: async () => {
      const pending = refreshed;
      refreshed = undefined;
      const apiKey = pending === undefined ? await getToken() : await pending;
      return apiKey === undefined ? undefined : { apiKey };
    },
    canRecover: (error) => errorStatusCode(error) === 401,
    invalidate: () => {
      refreshed ??= getToken({ force: true });
      refreshed.catch(() => {});
    },
  };
}

export function applyCredential(
  model: LlmModel,
  credential: LlmCredential | undefined,
): LlmModel {
  if (credential === undefined) {
    return model;
  }
  const headers = mergeRequestHeaders(model.defaultHeaders, credential.headers);
  for (const remove of credential.removeHeaders ?? []) {
    for (const key of Object.keys(headers ?? {})) if (key.toLowerCase() === remove.toLowerCase()) delete headers?.[key];
  }
  return {
    ...model,
    baseUrl: credential.baseUrl ?? model.baseUrl,
    proxyUrl: credential.proxyUrl ?? model.proxyUrl,
    apiKey: credential.apiKey ?? model.apiKey,
    defaultHeaders: headers,
    removeHeaders: credential.removeHeaders ?? model.removeHeaders,
  };
}

const CREDENTIALS_RECOVERY_ID = 'credentials';

export const credentialsRecovery: LlmRecovery = {
  propose: ({ error, appliedRecoveries, credentialProvider }) => {
    if (
      credentialProvider?.canRecover?.(error) !== true ||
      appliedRecoveries.some((record) => record.strategy === CREDENTIALS_RECOVERY_ID)
    ) {
      return undefined;
    }
    return {
      strategy: CREDENTIALS_RECOVERY_ID,
      action: 'refresh',
      beforeNextAttempt: () => credentialProvider?.invalidate?.(),
    };
  },
};
