import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import tls from 'node:tls';
import { Socket } from 'node:net';
import { getGlobalDispatcher, setGlobalDispatcher, MockAgent } from 'undici';
import { withScopedProxy, withOriginDispatcher } from '#/_base/utils/scopedProxy';
import { createNoSniConnector } from '#/_base/utils/tls';

import {
  createProxyDispatcher,
  installGlobalProxyDispatcher,
  isProxyConfigured,
  makeNoProxyMatcher,
  proxyEnvForChild,
  reconcileChildNoProxy,
  resolveNoProxy,
  resolveSocksProxy,
} from '#/_base/utils/proxy';

describe('proxy utilities', () => {
  it('omits SNI without disabling certificate or URL-hostname verification', async () => {
    const socket = new tls.TLSSocket(new Socket());
    let options: tls.ConnectionOptions | undefined;
    const connect = vi.spyOn(tls, 'connect').mockImplementation(((input: tls.ConnectionOptions) => { options = input; return socket; }) as typeof tls.connect);
    try {
      const done = new Promise<void>((resolve, reject) => {
        createNoSniConnector()({ hostname: 'example.test', host: 'example.test', servername: 'example.test', protocol: 'https:', port: '443' }, (error, _socket) => {
          if (error) reject(error); else resolve();
        });
      });
      socket.emit('secureConnect');
      await done;
      expect(options).toMatchObject({ servername: null, host: 'example.test', rejectUnauthorized: true });
      expect(options?.checkServerIdentity).toBe(tls.checkServerIdentity);
      expect(options?.checkServerIdentity?.('example.test', { subjectaltname: 'DNS:wrong.example.test' } as tls.PeerCertificate)).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    } finally { connect.mockRestore(); socket.destroy(); }
  });

  it('limits a transport override to its selected origin and keeps the fallback for other hosts', async () => {
    const original = getGlobalDispatcher();
    const fallback = new MockAgent();
    const selected = new MockAgent();
    fallback.disableNetConnect(); selected.disableNetConnect();
    fallback.get('https://other.example.test').intercept({ path: '/' }).reply(200, 'fallback');
    selected.get('https://selected.example.test').intercept({ path: '/' }).reply(200, 'selected');
    setGlobalDispatcher(fallback);
    try {
      const values = await withOriginDispatcher('https://selected.example.test', selected, async () => Promise.all([
        fetch('https://selected.example.test/').then(response => response.text()),
        fetch('https://other.example.test/').then(response => response.text()),
      ]));
      expect(values).toEqual(['selected', 'fallback']);
    } finally { setGlobalDispatcher(original); await selected.close(); await fallback.close(); }
  });
  it('routes only the selected async scope through a proxy while concurrent requests keep their own route', async () => {
    const original = getGlobalDispatcher();
    const direct = createServer((_request, response) => response.end('direct'));
    const proxy = createServer();
    proxy.on('connect', (_request, socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied'));
    });
    await Promise.all([new Promise<void>(resolve => direct.listen(0, '127.0.0.1', resolve)), new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))]);
    const target = direct.address();
    const gateway = proxy.address();
    if (target === null || gateway === null || typeof target === 'string' || typeof gateway === 'string') throw new Error('Missing listener');
    try {
      const url = `http://127.0.0.1:${target.port}/`;
      const results = await Promise.all([
        withScopedProxy(`http://127.0.0.1:${gateway.port}`, async () => (await fetch(url)).text()),
        withScopedProxy(undefined, async () => (await fetch(url)).text()),
      ]);
      expect(results).toEqual(['proxied', 'direct']);
    } finally {
      setGlobalDispatcher(original);
      direct.closeAllConnections(); proxy.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => direct.close(() => { resolve(); })), new Promise<void>(resolve => proxy.close(() => { resolve(); }))]);
    }
  });
  it('detects HTTP, HTTPS, ALL_PROXY, and SOCKS proxy configuration', () => {
    expect(isProxyConfigured({})).toBe(false);
    expect(isProxyConfigured({ HTTP_PROXY: 'http://p:3128' })).toBe(true);
    expect(isProxyConfigured({ http_proxy: 'http://p:3128' })).toBe(true);
    expect(isProxyConfigured({ HTTPS_PROXY: 'http://p:3128' })).toBe(true);
    expect(isProxyConfigured({ HTTP_PROXY: '   ' })).toBe(false);
    expect(isProxyConfigured({ ALL_PROXY: 'socks5://127.0.0.1:1080' })).toBe(true);
    expect(isProxyConfigured({ ALL_PROXY: 'http://proxy:8080' })).toBe(true);
  });

  it('resolves NO_PROXY with loopback protection and wildcard passthrough', () => {
    expect(resolveNoProxy({})).toBe('localhost,127.0.0.1,::1,[::1]');
    expect(resolveNoProxy({ NO_PROXY: 'example.com, 127.0.0.1' })).toBe(
      'example.com,127.0.0.1,localhost,::1,[::1]',
    );
    expect(resolveNoProxy({ no_proxy: 'internal' })).toBe(
      'internal,localhost,127.0.0.1,::1,[::1]',
    );
    expect(resolveNoProxy({ NO_PROXY: '*' })).toBe('*');
  });

  it('parses SOCKS proxy URLs from proxy env vars', () => {
    expect(resolveSocksProxy({})).toBeUndefined();
    expect(resolveSocksProxy({ HTTP_PROXY: 'http://p:3128' })).toBeUndefined();
    expect(resolveSocksProxy({ ALL_PROXY: 'socks5://10.0.0.1' })).toEqual({
      type: 5,
      host: '10.0.0.1',
      port: 1080,
    });
    expect(resolveSocksProxy({ ALL_PROXY: 'socks4://127.0.0.1:1080' })).toEqual({
      type: 4,
      host: '127.0.0.1',
      port: 1080,
    });
    expect(resolveSocksProxy({ ALL_PROXY: 'socks5://user:pass@127.0.0.1:1080' })).toEqual({
      type: 5,
      host: '127.0.0.1',
      port: 1080,
      userId: 'user',
      password: 'pass',
    });
  });

  it('matches NO_PROXY host, wildcard, subdomain, port, and IPv6 entries', () => {
    expect(makeNoProxyMatcher('*')('example.com')).toBe(true);

    const bypass = makeNoProxyMatcher('localhost,.example.com,::1');
    expect(bypass('localhost')).toBe(true);
    expect(bypass('example.com')).toBe(true);
    expect(bypass('sub.example.com')).toBe(true);
    expect(bypass('[::1]')).toBe(true);
    expect(bypass('other.example.test')).toBe(false);

    const portBypass = makeNoProxyMatcher('api.example.com:443');
    expect(portBypass('api.example.com', 443)).toBe(true);
    expect(portBypass('api.example.com', 80)).toBe(false);
  });

  it('builds dispatchers for HTTP and SOCKS proxy configurations', () => {
    const http = { id: 'http' } as never;
    const socks = { id: 'socks' } as never;
    const makeHttpAgent = vi.fn().mockReturnValue(http);
    const makeSocksAgent = vi.fn().mockReturnValue(socks);

    expect(
      createProxyDispatcher(
        { HTTP_PROXY: 'http://p:3128', NO_PROXY: 'corp' },
        { makeHttpAgent, makeSocksAgent },
      ),
    ).toBe(http);
    expect(makeHttpAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        httpProxy: 'http://p:3128',
        noProxy: 'corp,localhost,127.0.0.1,::1,[::1]',
      }),
    );

    expect(
      createProxyDispatcher(
        { ALL_PROXY: 'socks5://127.0.0.1:1080', NO_PROXY: 'corp' },
        { makeHttpAgent, makeSocksAgent },
      ),
    ).toBe(socks);
    expect(makeSocksAgent).toHaveBeenCalledWith({
      proxy: { type: 5, host: '127.0.0.1', port: 1080 },
      noProxy: 'corp,localhost,127.0.0.1,::1,[::1]',
    });
  });

  it('installs the global dispatcher only when a proxy dispatcher exists', () => {
    const dispatcher = { id: 'dispatcher' } as never;
    const setGlobalDispatcher = vi.fn();
    const createDispatcher = vi.fn().mockReturnValue(dispatcher);

    expect(
      installGlobalProxyDispatcher(
        { HTTP_PROXY: 'http://p:3128' },
        { setGlobalDispatcher, createProxyDispatcher: createDispatcher },
      ),
    ).toBe(true);
    expect(setGlobalDispatcher).toHaveBeenCalledWith(dispatcher);

    setGlobalDispatcher.mockClear();
    createDispatcher.mockReturnValue(undefined);
    expect(
      installGlobalProxyDispatcher(
        {},
        { setGlobalDispatcher, createProxyDispatcher: createDispatcher },
      ),
    ).toBe(false);
    expect(setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it('prepares proxy env for child processes and reconciles NO_PROXY overrides', () => {
    expect(proxyEnvForChild({})).toEqual({});
    expect(proxyEnvForChild({ ALL_PROXY: 'socks5://127.0.0.1:1080' })).toEqual({});
    expect(proxyEnvForChild({ HTTP_PROXY: 'http://p:3128', NO_PROXY: 'corp' })).toEqual({
      NODE_USE_ENV_PROXY: '1',
      NO_PROXY: 'corp,localhost,127.0.0.1,::1,[::1]',
      no_proxy: 'corp,localhost,127.0.0.1,::1,[::1]',
      HTTP_PROXY: 'http://p:3128',
      http_proxy: 'http://p:3128',
    });

    const childEnv: Record<string, string> = {
      NO_PROXY: 'aug',
      no_proxy: 'aug',
    };
    reconcileChildNoProxy(childEnv, { no_proxy: '', NO_PROXY: 'internal.example.test' });
    expect(childEnv['NO_PROXY']).toBe('internal.example.test,localhost,127.0.0.1,::1,[::1]');
    expect(childEnv['no_proxy']).toBe('internal.example.test,localhost,127.0.0.1,::1,[::1]');
  });
});
