import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';

export interface FeedbackIdentity { device: string; username: string; id: string }
const COMPONENT = /^[\p{L}\p{N}_.-]{1,63}$/u;

export function parseFeedbackIdentity(value: unknown): FeedbackIdentity {
  if (!value || typeof value !== 'object') throw new Error('Invalid feedback identity');
  const { device, username } = value as Partial<FeedbackIdentity>;
  if (typeof device !== 'string' || typeof username !== 'string' ||
      !COMPONENT.test(device) || !COMPONENT.test(username)) throw new Error('Invalid feedback identity');
  return { device, username, id: `${device}-${username}` };
}

export function feedbackIdentity(device = hostname(), username = userInfo().username): FeedbackIdentity {
  const clean = (value: string) => value.normalize('NFKC').replaceAll(/[^\p{L}\p{N}_.-]/gu, '_').slice(0, 63) || 'unknown';
  return parseFeedbackIdentity({ device: clean(device), username: clean(username) });
}

export function feedbackIdentityPath(home: string, identity = feedbackIdentity()): string {
  const key = createHash('sha256').update(JSON.stringify([identity.device, identity.username])).digest('hex');
  return join(home, 'feedback', 'identities', `${key}.json`);
}
