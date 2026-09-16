export function normalizeProxyAddress(input: string): string | undefined {
  const value = input.trim();
  if (!value || value.length > 2048 || /[\s\\]/u.test(value)) return undefined;
  const address = /^\d+$/u.test(value) ? `http://127.0.0.1:${value}` : value.includes('://') ? value : `http://${value}`;
  const match = /^(https?):\/\/(\[[0-9a-f:.]+\]|[^:/?#@\s]+)(?::(\d+))?\/?$/iu.exec(address);
  if (!match || (match[3] !== undefined && (Number(match[3]) < 1 || Number(match[3]) > 65535))) return undefined;
  try {
    const url = new URL(address);
    if (!url.hostname.startsWith('[') && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9.])?$/iu.test(url.hostname)) return undefined;
    return url.origin;
  } catch { return undefined; }
}
