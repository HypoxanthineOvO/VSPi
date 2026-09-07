import { randomUUID } from 'node:crypto';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import type { AuthPrompt, OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai';
import type { BearerTokenProvider } from '@moonshot-ai/kimi-code-oauth';
import { Error2 } from '#/_base/errors/errors';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IProviderService, OAuthRef, ProvidersChangedEvent } from '#/kosong/provider/provider';
import type { ProviderRequestAuth } from '#/kosong/contract/provider';
import { AuthErrors } from './errors';
import type {
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthLoginCancelResponse,
  OAuthLoginPrompt,
} from './oauthProtocol';

const FLOW_TIMEOUT_MS = 15 * 60 * 1000;
const RETENTION_MS = 5 * 60 * 1000;

registerBunOAuthFlows();

interface PiOAuthProvider {
  readonly id: string;
  readonly name: string;
  readonly oauth: OAuthAuth;
}

interface PiFlow {
  readonly controller: AbortController;
  readonly snapshot: OAuthFlowSnapshot;
  readonly ready: Promise<OAuthFlowStart>;
  readonly resolveReady: (value: OAuthFlowStart) => void;
  readonly rejectReady: (reason: unknown) => void;
  readySettled: boolean;
  provisioning: boolean;
  resolveInput?: (input: string) => void;
  rejectInput?: (reason: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class PiOAuthAdapter {
  private readonly flows = new Map<string, PiFlow>();
  private readonly transactions = new Map<string, Promise<unknown>>();
  private readonly generations = new Map<string, number>();
  private readonly credentialKeys = new Map<string, Set<string>>();
  private disposed = false;
  private readonly refreshController = new AbortController();

  constructor(
    private readonly docs: IAtomicDocumentStore,
    private readonly providers: IProviderService,
    private readonly scope: string,
    private readonly provisionModels: (provider: string, type: string) => Promise<void>,
  ) {}

  list(): readonly { id: string; name: string }[] {
    return builtinProviders().filter((provider) => provider.auth.oauth !== undefined)
      .map(({ id, name }) => ({ id, name }));
  }

  handles(provider: string, ref?: OAuthRef): boolean {
    return this.definition(provider, ref) !== undefined;
  }

  async startLogin(provider: string): Promise<OAuthFlowStart> {
    if (this.disposed) throw authError('OAuth service has been disposed.');
    const definition = this.definition(provider);
    if (definition === undefined) throw authError('OAuth provider is not supported.');
    this.cancelLogin(provider);
    clearTimeout(this.flows.get(provider)?.timer);
    const ready = deferred<OAuthFlowStart>();
    const flow: PiFlow = {
      controller: new AbortController(),
      snapshot: {
        flow_id: `oauth_${randomUUID()}`,
        provider,
        status: 'pending',
        verification_uri: '',
        verification_uri_complete: '',
        user_code: '',
        expires_in: FLOW_TIMEOUT_MS / 1000,
        interval: 1,
        expires_at: new Date(Date.now() + FLOW_TIMEOUT_MS).toISOString(),
      },
      ready: ready.promise,
      resolveReady: ready.resolve,
      rejectReady: ready.reject,
      readySettled: false,
      provisioning: false,
    };
    this.flows.set(provider, flow);
    flow.timer = setTimeout(() => this.finish(flow, 'expired'), FLOW_TIMEOUT_MS);
    flow.timer.unref();
    void this.login(provider, definition, flow);
    return flow.ready;
  }

  getFlow(provider: string): OAuthFlowSnapshot | undefined {
    const snapshot = this.flows.get(provider)?.snapshot;
    return snapshot === undefined ? undefined : structuredClone(snapshot);
  }

  submitLogin(provider: string, flowId: string, promptId: string, input: string): void {
    const flow = this.flows.get(provider);
    if (
      flow === undefined || flow.snapshot.status !== 'pending' ||
      flow.snapshot.flow_id !== flowId || flow.snapshot.prompt?.id !== promptId ||
      flow.resolveInput === undefined
    ) throw authError('OAuth input no longer belongs to an active prompt.');
    const prompt = flow.snapshot.prompt;
    if (!prompt.allow_empty && input.trim().length === 0) {
      throw authError('OAuth input must not be empty.');
    }
    if (prompt.options !== undefined && !prompt.options.some((option) => option.id === input)) {
      throw authError('OAuth selection is not one of the available options.');
    }
    const resolve = flow.resolveInput;
    flow.resolveInput = undefined;
    flow.rejectInput = undefined;
    flow.snapshot.prompt = undefined;
    resolve(input);
  }

  cancelLogin(provider: string): OAuthLoginCancelResponse {
    const flow = this.flows.get(provider);
    if (flow === undefined || flow.snapshot.status !== 'pending') {
      return { cancelled: false, status: flow?.snapshot.status ?? 'cancelled' };
    }
    this.finish(flow, 'cancelled');
    return { cancelled: true, status: 'cancelled' };
  }

  invalidateProviders(event: ProvidersChangedEvent): void {
    for (const provider of [...event.changed, ...event.removed]) {
      for (const key of this.credentialKeys.get(provider) ?? []) {
        this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      }
      const flow = this.flows.get(provider);
      if (flow?.snapshot.status === 'pending' && !flow.provisioning) this.cancelLogin(provider);
    }
  }

  async logout(provider: string, ref?: OAuthRef): Promise<void> {
    this.cancelLogin(provider);
    const key = this.credentialKey(provider, ref);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    await this.transaction(key, () => this.docs.delete(this.scope, key));
  }

  async getCachedAccessToken(provider: string, ref?: OAuthRef): Promise<string | undefined> {
    const definition = this.definition(provider, ref);
    if (definition === undefined) return undefined;
    const credentials = await this.docs.get<OAuthCredential>(this.scope, this.credentialKey(provider, ref));
    return credentials?.access;
  }

  tokenProvider(provider: string, ref?: OAuthRef): BearerTokenProvider {
    return { getAccessToken: async (options) => {
      const auth = await this.getRequestAuth(provider, ref, options?.force === true);
      if (!auth.apiKey) throw authError('This OAuth provider requires request-level auth material.');
      return auth.apiKey;
    } };
  }

  dispose(): void {
    this.disposed = true;
    this.refreshController.abort();
    for (const flow of this.flows.values()) {
      if (flow.snapshot.status === 'pending') this.finish(flow, 'cancelled');
      clearTimeout(flow.timer);
    }
    this.flows.clear();
  }

  private definition(provider: string, ref?: OAuthRef): PiOAuthProvider | undefined {
    const config = this.providers.get(provider);
    const key = (ref ?? config?.oauth)?.key;
    const id = key?.startsWith('pi-ai/') ? key.split('/')[1] : undefined;
    const definition = builtinProviders().find((candidate) => candidate.id === (id ?? config?.type ?? provider));
    const oauth = definition?.auth.oauth;
    return definition === undefined || oauth === undefined ? undefined : { id: definition.id, name: definition.name, oauth };
  }

  private credentialKey(provider: string, ref?: OAuthRef): string {
    const definition = this.definition(provider, ref);
    if (definition === undefined) throw authError('OAuth provider is not supported.');
    const key = (ref ?? this.providers.get(provider)?.oauth)?.key;
    const resolved = key?.startsWith('pi-ai/') ? key : `pi-ai/${definition.id}/${encodeURIComponent(provider)}`;
    const keys = this.credentialKeys.get(provider) ?? new Set<string>();
    keys.add(resolved);
    this.credentialKeys.set(provider, keys);
    return resolved;
  }

  private async login(provider: string, definition: PiOAuthProvider, flow: PiFlow): Promise<void> {
    try {
      const credentials = await definition.oauth.login({
        signal: flow.controller.signal,
        notify: (event) => {
          if (flow.snapshot.status !== 'pending') return;
          if (event.type === 'auth_url') {
            flow.snapshot.auth_url = event.url;
            flow.snapshot.instructions = event.instructions;
          } else if (event.type === 'device_code') {
            flow.snapshot.verification_uri = event.verificationUri;
            flow.snapshot.verification_uri_complete = event.verificationUri;
            flow.snapshot.user_code = event.userCode;
            flow.snapshot.interval = event.intervalSeconds ?? 1;
            if (event.expiresInSeconds !== undefined) {
              flow.snapshot.expires_in = event.expiresInSeconds;
              flow.snapshot.expires_at = new Date(Date.now() + event.expiresInSeconds * 1000).toISOString();
              clearTimeout(flow.timer);
              flow.timer = setTimeout(() => this.finish(flow, 'expired'), event.expiresInSeconds * 1000);
              flow.timer.unref();
            }
          } else return;
          this.publishReady(flow);
        },
        prompt: (prompt) => this.prompt(flow, prompt),
      });
      if (flow.snapshot.status !== 'pending') return;
      const key = this.credentialKey(provider);
      await this.transaction(key, async () => {
        if (flow.snapshot.status !== 'pending') return;
        flow.provisioning = true;
        await this.docs.set(this.scope, key, credentials);
        if (flow.snapshot.status !== 'pending') {
          await this.docs.delete(this.scope, key);
          return;
        }
        const configured = this.providers.get(provider);
        await this.providers.set(provider, {
          ...configured,
          type: configured?.type ?? definition.id,
          apiKey: undefined,
          oauth: { storage: 'file', key },
        });
        if (flow.snapshot.status === 'pending') await this.provisionModels(provider, definition.id);
      });
      if (flow.snapshot.status === 'pending') this.finish(flow, 'authenticated');
    } catch {
      if (flow.snapshot.status === 'pending') this.finish(flow, 'denied');
    }
  }

  private prompt(flow: PiFlow, prompt: AuthPrompt): Promise<string> {
    if (flow.snapshot.status !== 'pending') return Promise.reject(authError('OAuth login was cancelled.'));
    flow.rejectInput?.(authError('OAuth prompt was replaced.'));
    const input = deferred<string>();
    flow.resolveInput = input.resolve;
    flow.rejectInput = input.reject;
    const presented: OAuthLoginPrompt = prompt.type === 'select'
      ? { id: randomUUID(), message: prompt.message, options: prompt.options.map(({ id, label }) => ({ id, label })) }
      : { id: randomUUID(), message: prompt.message, placeholder: prompt.placeholder, allow_empty: prompt.type === 'text' };
    flow.snapshot.prompt = presented;
    const abort = () => {
      if (flow.snapshot.prompt?.id === presented.id) {
        flow.snapshot.prompt = undefined;
        flow.resolveInput = undefined;
        flow.rejectInput = undefined;
      }
      input.reject(authError('OAuth prompt was cancelled.'));
    };
    if (prompt.signal?.aborted) abort();
    else prompt.signal?.addEventListener('abort', abort, { once: true });
    this.publishReady(flow);
    return input.promise.finally(() => prompt.signal?.removeEventListener('abort', abort));
  }

  private publishReady(flow: PiFlow): void {
    if (flow.readySettled) return;
    flow.readySettled = true;
    flow.resolveReady({ ...structuredClone(flow.snapshot), status: 'pending' });
  }

  private finish(flow: PiFlow, status: 'authenticated' | 'denied' | 'expired' | 'cancelled'): void {
    if (flow.snapshot.status !== 'pending') return;
    flow.snapshot.status = status;
    flow.snapshot.resolved_at = new Date().toISOString();
    flow.snapshot.prompt = undefined;
    if (status !== 'authenticated') {
      flow.snapshot.error_message = status === 'denied'
        ? 'OAuth login failed. Please start a new login and verify provider access.'
        : `OAuth login ${status}.`;
    }
    flow.controller.abort();
    flow.rejectInput?.(authError(`OAuth login ${status}.`));
    flow.rejectInput = undefined;
    flow.resolveInput = undefined;
    if (!flow.readySettled) {
      flow.readySettled = true;
      if (status === 'authenticated') {
        flow.resolveReady({ flow_id: flow.snapshot.flow_id, provider: flow.snapshot.provider, status });
      } else {
        flow.rejectReady(authError(flow.snapshot.error_message ?? 'OAuth login failed.'));
      }
    }
    clearTimeout(flow.timer);
    flow.timer = setTimeout(() => {
      if (this.flows.get(flow.snapshot.provider) === flow) this.flows.delete(flow.snapshot.provider);
    }, RETENTION_MS);
    flow.timer.unref();
  }

  async getRequestAuth(provider: string, ref: OAuthRef | undefined, force = false): Promise<ProviderRequestAuth> {
    const key = this.credentialKey(provider, ref);
    const generation = this.generations.get(key) ?? 0;
    return this.transaction(key, async () => {
      const definition = this.definition(provider, ref);
      let credentials = await this.docs.get<OAuthCredential>(this.scope, key);
      if (definition === undefined || credentials === undefined || this.disposed) {
        throw authError('OAuth credentials are missing; please log in.');
      }
      if (force || credentials.expires <= Date.now() + 60_000) {
        try {
          credentials = await definition.oauth.refresh(credentials, this.refreshController.signal);
        } catch {
          throw authError('OAuth token refresh failed; please log in again.');
        }
        if (this.disposed || generation !== (this.generations.get(key) ?? 0)) {
          throw authError('OAuth credentials were invalidated during refresh.');
        }
        await this.docs.set(this.scope, key, credentials);
      }
      if (generation !== (this.generations.get(key) ?? 0)) throw authError('OAuth credentials were invalidated.');
      let auth;
      try {
        auth = await definition.oauth.toAuth(credentials);
      } catch {
        throw authError('OAuth request authentication could not be resolved; please log in again.');
      }
      if (this.disposed || generation !== (this.generations.get(key) ?? 0)) throw authError('OAuth credentials were invalidated.');
      const headers = Object.entries(auth.headers ?? {});
      return {
        apiKey: auth.apiKey,
        headers: Object.fromEntries(headers.filter((entry): entry is [string, string] => entry[1] !== null)),
        removeHeaders: headers.filter(([, value]) => value === null).map(([name]) => name),
        baseUrl: auth.baseUrl,
      };
    });
  }

  private transaction<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.transactions.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.transactions.set(key, next);
    void next.finally(() => {
      if (this.transactions.get(key) === next) this.transactions.delete(key);
    }).catch(() => {});
    return next;
  }
}

function authError(message: string): Error2 {
  return new Error2(AuthErrors.codes.AUTH_LOGIN_REQUIRED, message);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
