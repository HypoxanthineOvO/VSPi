export function currentModelId(value: string): string {
  const slash = value.lastIndexOf('/');
  const prefix = value.slice(0, slash + 1);
  const name = value.slice(slash + 1);
  const retired = /^(deepseek-(?:v4\.1-flash|v4-flash|v4-pro|flash))-(?:expires?|expire)-on-\d[\d-]*$/i.exec(name);
  const id = retired?.[1]?.toLowerCase() ?? name;
  return `${prefix}${id === 'deepseek-v4.1-flash' ? 'deepseek-flash' : id}`;
}
