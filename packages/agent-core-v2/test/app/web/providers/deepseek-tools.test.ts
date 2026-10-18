import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekFetchURLProvider, DeepSeekWebSearchProvider } from '#/app/web/providers/deepseek-tools';

const config = { apiKey: 'YOUR_API_KEY' };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('DeepSeek Search and Fetch', () => {
  it('uses independent credentials, official endpoints and service-specific request/response shapes', async () => {
    vi.stubEnv('EXAMPLE_DEEPSEEK_KEY', 'ENV_API_KEY');
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ results: [{ title: 'Result', url: 'https://example.com', snippet: 'Snippet', date: null }] })).mockResolvedValueOnce(Response.json({ title: 'Page', content: '# Markdown\nContent' }));
    vi.stubGlobal('fetch', fetchMock);
    const search = new DeepSeekWebSearchProvider({ apiKeyEnv: 'EXAMPLE_DEEPSEEK_KEY', count: 3 });
    expect(await search.search('中文')).toEqual([{ title: 'Result', url: 'https://example.com', snippet: 'Snippet' }]);
    expect(await new DeepSeekFetchURLProvider(config).fetch('https://example.com')).toEqual({ content: '# Markdown\nContent', kind: 'extracted' });
    const [searchUrl, searchInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const [fetchUrl, fetchInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(String(searchUrl)).toBe('https://api.deepseek.com/v1/tools/search');
    expect(String(fetchUrl)).toBe('https://api.deepseek.com/v1/tools/fetch');
    expect(Object.fromEntries(new Headers(searchInit.headers))).toEqual({ authorization: 'Bearer ENV_API_KEY', 'content-type': 'application/json' });
    expect(Object.fromEntries(new Headers(fetchInit.headers))).toEqual({ authorization: 'Bearer YOUR_API_KEY', 'content-type': 'application/json' });
    expect(JSON.parse(searchInit.body as string)).toEqual({ query: '中文', count: 3 });
    expect(JSON.parse(fetchInit.body as string)).toEqual({ url: 'https://example.com' });
    expect(searchInit.redirect).toBe('manual');
  });
  it('supports explicit relay endpoints without forwarding host identity headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ results: [] })); vi.stubGlobal('fetch', fetchMock);
    await new DeepSeekWebSearchProvider({ ...config, baseUrl: 'https://relay.example.test/search', customHeaders: { 'X-Route': 'example', authorization: 'Ignored override' } }).search('query');
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('https://relay.example.test/search');
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({ 'x-route': 'example', authorization: 'Bearer YOUR_API_KEY', 'content-type': 'application/json' });
  });
  it('rejects missing explicit service credentials and never borrows provider keys', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'PROVIDER_KEY'); vi.stubEnv('EXAMPLE_MISSING_KEY', '');
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(new DeepSeekWebSearchProvider({}).search('query')).rejects.toThrow('own services credential');
    await expect(new DeepSeekFetchURLProvider({ ...config, apiKeyEnv: 'EXAMPLE_MISSING_KEY' }).fetch('https://example.com')).rejects.toThrow('own services credential');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([301, 302, 307, 400, 401, 402, 403, 429, 500])('reports HTTP %i once without following redirects or falling back', async status => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Private upstream details', { status, headers: { location: 'https://other.example.test' } }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await new DeepSeekWebSearchProvider(config).search('query').catch(error => error);
    expect(error).toMatchObject({ status });
    expect(error.message).not.toContain('Private upstream details');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('validates Unicode query lengths and fetch URL schemes/credentials before HTTP', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ results: [] })); vi.stubGlobal('fetch', fetchMock);
    await new DeepSeekWebSearchProvider(config).search('🌏'.repeat(128));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const query of ['', '🌏'.repeat(129)]) await expect(new DeepSeekWebSearchProvider(config).search(query)).rejects.toThrow('1–128');
    for (const url of ['file:///etc/passwd', 'ftp://example.com', 'https://user:pass@example.com', 'invalid', `https://example.com/${'a'.repeat(8192)}`])
      await expect(new DeepSeekFetchURLProvider(config).fetch(url)).rejects.toThrow('HTTP(S)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(['https://YOUR_API_KEY@relay.example.test', 'https://relay.example.test?key=secret', 'file:///example'])('rejects unsafe service endpoint %s', async baseUrl => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(new DeepSeekWebSearchProvider({ ...config, baseUrl }).search('query')).rejects.toThrow('endpoint');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON and invalid successful responses', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{')).mockResolvedValueOnce(Response.json({ results: [{ title: 'Partial' }] })).mockResolvedValueOnce(Response.json({ title: 'Partial' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new DeepSeekWebSearchProvider(config).search('query')).rejects.toThrow('invalid JSON');
    await expect(new DeepSeekWebSearchProvider(config).search('query')).rejects.toThrow('invalid results');
    await expect(new DeepSeekFetchURLProvider(config).fetch('https://example.com')).rejects.toThrow('invalid page');
  });
  it('bounds a streaming response before reading the full body', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    await expect(new DeepSeekWebSearchProvider(config).search('query')).rejects.toThrow('10 MiB');
    expect(cancelled).toBe(true);
  });
  it('honors both caller cancellation and the configured timeout against a real HTTP server', async () => {
    const server = createServer((_request, _response) => {});
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
    const baseUrl = `http://127.0.0.1:${address.port}/search`;
    try {
      await expect(new DeepSeekWebSearchProvider({ ...config, baseUrl, timeoutMs: 30 }).search('query')).rejects.toMatchObject({ name: 'TimeoutError' });
      const controller = new AbortController(); controller.abort();
      await expect(new DeepSeekWebSearchProvider({ ...config, baseUrl }).search('query', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
