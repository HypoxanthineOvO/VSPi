import { checkServerIdentity } from 'node:tls';
import { buildConnector } from 'undici';

export function createNoSniConnector(): ReturnType<typeof buildConnector> {
  const connect = buildConnector({ rejectUnauthorized: true, checkServerIdentity });
  return (options, callback) => {
    connect({ ...options, host: undefined, servername: undefined }, callback);
  };
}
