import type { ModelRecord } from '#/llm-adapter/model/model';
import { child, children, number, text, type Proto } from './protobuf';
import { DEVIN_BASE_URL, DEVIN_CATALOG_PATH, devinMetadata, devinUnary } from './wire';

export const DEVIN_FALLBACK_MODELS: Record<string, ModelRecord> = Object.fromEntries(['swe-1-6', 'swe-1-6-fast'].map(id => [id, {
  provider: 'devin', protocol: 'openai', model: id,
  displayName: id === 'swe-1-6' ? 'SWE-1.6' : 'SWE-1.6 Fast',
  maxContextSize: 200000, maxOutputSize: 64000, capabilities: ['tool_use'],
}]));
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function normalizeDevinModels(response: Proto, provider = 'devin'): Record<string, ModelRecord> {
  const records: Record<string, ModelRecord> = {};
  const families = new Map<string, { label: string; members: string[]; routing: Record<string, string>; defaultUid?: string }>();
  const accountDefault = text(child(response, 3), 1);
  for (const config of children(response, 1)) {
    const uid = text(config, 22).trim();
    const info = child(config, 23);
    const display = number(info, 22);
    if (!uid || number(config, 4) || number(info, 2) || number(info, 25) || [3, 4, 6].includes(display) || /^(?:fusion|adaptive|subagent-default)(?:-|$)/i.test(uid)) continue;
    if (records[`${provider}/${uid}`]) continue;
    const features = child(info, 6);
    const label = text(config, 1).trim() || uid;
    const thinking = features.size > 0 ? number(features, 15) === 1 : /think|reasoning/i.test(label) && !/no thinking/i.test(label);
    const image = (features.size > 0 ? number(features, 11) : number(config, 5)) === 1 && !['swe-1-6', 'swe-1-6-fast'].includes(uid);
    const tools = features.size === 0 || number(features, 12) === 1;
    records[`${provider}/${uid}`] = {
      provider, protocol: 'openai', model: uid, displayName: label,
      maxContextSize: number(config, 18) || number(info, 4) || 200000,
      maxOutputSize: number(info, 13) || 64000,
      capabilities: [...tools ? ['tool_use'] : [], ...thinking ? ['thinking'] : [], ...image ? ['image_in'] : []],
      thinking: { availability: thinking ? 'always' : 'none', canDisable: false, controls: [] },
    };
    const family = child(config, 30);
    const familyLabel = text(family, 1).trim();
    if (!familyLabel) continue;
    let effort: string | undefined;
    let fast = false;
    let large = false;
    for (const entry of children(family, 2)) {
      const key = text(entry, 1).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const value = child(entry, 2);
      if (key === 'fast mode') fast = number(value, 1) === 1;
      if (key === '1m context') large = number(value, 1) === 1;
      if (key === 'effort' || key === 'reasoning effort') {
        const name = text(value, 2).toLowerCase().replace(/[^a-z0-9]+/g, '');
        effort = name === 'none' || name === 'nothinking' ? 'off' : EFFORTS.includes(name) ? name : undefined;
      }
    }
    const thinkingAxis = children(family, 2).find(entry => text(entry, 1).toLowerCase().trim() === 'thinking');
    if (thinkingAxis && number(child(thinkingAxis, 2), 1) === 0) effort = 'off';
    const id = familyLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + (large ? '-1m' : '') + (fast ? '-fast' : '');
    const lane = families.get(id) ?? { label: `${familyLabel}${large ? ' 1M' : ''}${fast ? ' Fast' : ''}`, members: [], routing: {} };
    lane.members.push(uid);
    if (effort !== undefined && lane.routing[effort] === undefined) lane.routing[effort] = uid;
    if (uid === accountDefault || (!lane.defaultUid && (number(config, 31) || number(family, 3)))) lane.defaultUid = uid;
    families.set(id, lane);
  }
  for (const [id, family] of families) {
    const efforts = EFFORTS.filter(effort => family.routing[effort]);
    if (efforts.length === 0) continue;
    const defaultUid = family.defaultUid ?? family.routing[efforts.includes('medium') ? 'medium' : efforts[0]!]!;
    const base = records[`${provider}/${defaultUid}`];
    if (!base) continue;
    for (const uid of family.members) delete records[`${provider}/${uid}`];
    const defaultEffort = Object.keys(family.routing).find(effort => family.routing[effort] === defaultUid);
    records[`${provider}/${id}`] = {
      ...base, displayName: family.label,
      capabilities: [...new Set([...(base.capabilities ?? []), 'thinking'])],
      effortMapping: family.routing,
      thinking: { availability: family.routing['off'] ? 'dynamic' : 'always', canDisable: !!family.routing['off'], controls: ['effort'], efforts, defaultEffort: defaultEffort === 'off' ? efforts[0] : defaultEffort },
    };
  }
  return Object.fromEntries(Object.entries(records).sort(([a], [b]) => a.localeCompare(b)));
}

export async function fetchDevinModels(token: string, provider = 'devin', baseUrl = DEVIN_BASE_URL, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Record<string, ModelRecord>> {
  const timeout = AbortSignal.timeout(15000);
  const response = await devinUnary(DEVIN_CATALOG_PATH, devinMetadata(token, '', true), baseUrl, signal ? AbortSignal.any([signal, timeout]) : timeout, fetchImpl);
  const records = normalizeDevinModels(response, provider);
  if (Object.keys(records).length > 0) return records;
  return Object.fromEntries(Object.entries(DEVIN_FALLBACK_MODELS).map(([id, record]) => [`${provider}/${id}`, { ...record, provider }]));
}
