import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { createPrivateFile, readPrivateFile } from '../utils/private-file.js';
import { parseFeedbackIdentity, type FeedbackIdentity } from './identity.js';

export async function createFeedbackRegistration(directory: string) {
  const path = join(directory, 'registration.key');
  await createPrivateFile(path, randomBytes(32));
  const key = await readPrivateFile(path, 32);
  if (key.length !== 32) throw new Error('Invalid feedback registration key');
  const signature = (payload: string) => createHmac('sha256', key).update(payload).digest();
  return {
    issue(identity: FeedbackIdentity): string {
      const payload = Buffer.from(JSON.stringify({ ...identity, nonce: randomBytes(32).toString('hex') })).toString('base64url');
      return `vspi1.${payload}.${signature(payload).toString('base64url')}`;
    },
    verify(token: string) {
      if (token.length > 2048) return undefined;
      const [version, payload, signed, extra] = token.split('.');
      if (version !== 'vspi1' || !payload || !signed || extra !== undefined) return undefined;
      const supplied = Buffer.from(signed, 'base64url');
      const expected = signature(payload);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
      try {
        const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { nonce?: unknown };
        const identity = parseFeedbackIdentity(value);
        if (typeof value.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(value.nonce)) return undefined;
        return { ...identity, credentialId: createHash('sha256').update(payload).digest('hex') };
      } catch { return undefined; }
    },
  };
}
