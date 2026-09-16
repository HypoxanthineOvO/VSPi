import { AsyncLocalStorage } from 'node:async_hooks';
import { Dispatcher, getGlobalDispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';

const current = new AsyncLocalStorage<Dispatcher>();

class ScopedProxyDispatcher extends Dispatcher {
  constructor(readonly fallback: Dispatcher) { super(); }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    return (current.getStore() ?? this.fallback).dispatch(options, handler);
  }
}

class OriginDispatcher extends Dispatcher {
  constructor(readonly origin: string, readonly selected: Dispatcher, readonly fallback: Dispatcher) { super(); }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    return (String(options.origin) === this.origin ? this.selected : this.fallback).dispatch(options, handler);
  }
}

export function withOriginDispatcher<T>(origin: string, dispatcher: Dispatcher, run: () => Promise<T>): Promise<T> {
  const global = getGlobalDispatcher();
  const fallback = current.getStore() ?? (global instanceof ScopedProxyDispatcher ? global.fallback : global);
  if (!(global instanceof ScopedProxyDispatcher)) setGlobalDispatcher(new ScopedProxyDispatcher(global));
  return current.run(new OriginDispatcher(origin, dispatcher, fallback), run);
}

export async function withScopedProxy<T>(url: string | undefined, run: () => Promise<T>): Promise<T> {
  if (url === undefined) return run();
  const global = getGlobalDispatcher();
  if (!(global instanceof ScopedProxyDispatcher)) setGlobalDispatcher(new ScopedProxyDispatcher(global));
  const dispatcher = new ProxyAgent(url);
  try { return await current.run(dispatcher, run); }
  finally { await dispatcher.destroy(); }
}
