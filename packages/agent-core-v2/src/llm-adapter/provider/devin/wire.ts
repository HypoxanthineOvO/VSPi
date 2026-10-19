import { APIProtocolError, APIStatusError } from '#/llm-adapter/contract/errors';
import { decodeUnary, field, message, retryDelay, text, type Proto } from './protobuf';

export const DEVIN_BASE_URL = 'https://server.codeium.com';
export const DEVIN_CHAT_PATH = '/exa.api_server_pb.ApiServerService/GetChatMessage';
export const DEVIN_CATALOG_PATH = '/exa.api_server_pb.ApiServerService/GetCliModelConfigs';

export function devinMetadata(token: string, jwt = '', discovery = false): Buffer {
  const apiKey = token.startsWith('devin-session-token$') ? token : `devin-session-token$${token}`;
  const version = discovery ? '0.0.0-dev' : '3000.11.3';
  return message(field(1, discovery ? 'chisel' : 'devin-cli'), field(2, version), field(3, apiKey),
    field(4, 'en'), field(5, process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux'),
    field(6, true), field(7, version), field(12, 'chisel'), field(21, jwt), field(28, discovery ? undefined : 'chisel'),
    ...(discovery ? [3, 4, 6, 7, 8].map((display) => field(30, display)) : []));
}

export function devinHttpError(response: Response): APIStatusError {
  return new APIStatusError(response.status, `Devin request failed (${response.status}).${response.status === 401 ? ' Re-login required.' : ''}`, response.headers.get('x-request-id'), retryDelay(response.headers));
}

export async function devinUnary(path: string, metadata: Buffer, baseUrl = DEVIN_BASE_URL, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Proto> {
  const response = await fetchImpl(baseUrl.replace(/\/+$/, '') + path, {
    method: 'POST', headers: { 'content-type': 'application/proto', 'connect-protocol-version': '1', accept: '*/*' },
    body: new Uint8Array(field(1, metadata)), signal,
  });
  if (!response.ok) throw devinHttpError(response);
  return decodeUnary(new Uint8Array(await response.arrayBuffer()));
}

export async function devinRequestAuth(token: string, baseUrl = DEVIN_BASE_URL, signal?: AbortSignal, fetchImpl: typeof fetch = fetch) {
  const result = await devinUnary('/exa.auth_pb.AuthService/GetUserJwt', devinMetadata(token), baseUrl, signal, fetchImpl);
  const userJwt = text(result, 1);
  if (!userJwt) throw new APIProtocolError('Devin GetUserJwt returned no user JWT.');
  const customUrl = text(result, 2).trim();
  if (customUrl && new URL(customUrl).protocol !== 'https:') throw new APIProtocolError('Devin returned an insecure API server URL.');
  return { userJwt, baseUrl: customUrl || baseUrl };
}
