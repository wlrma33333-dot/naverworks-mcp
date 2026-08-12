import crypto from 'node:crypto';
import { getConfig } from '../config.js';
import type { TokenRecord } from './store.js';

// openid를 추가하면 id_token(JWT)의 sub 클레임으로 본인 userId를 확정적으로 얻는다.
// 매 API 호출마다 "me" 리터럴이 먹히는지 확률적으로 확인하는 것보다 견고하다.
const SCOPES = ['calendar', 'task', 'mail', 'user.read', 'openid'] as const;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  scope: string;
  expires_in: string | number;
  token_type: string;
  error?: string;
  error_description?: string;
}

export function randomState(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function buildAuthorizeUrl(state: string): string {
  const config = getConfig();
  const url = new URL('/oauth2/v2.0/authorize', config.authBase);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url.toString();
}

async function requestToken(body: URLSearchParams): Promise<TokenResponse> {
  const config = getConfig();
  const res = await fetch(`${config.authBase}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) {
    throw new Error(
      `[oauth] 토큰 요청 실패 (${res.status}): ${json.error ?? ''} ${json.error_description ?? ''}`.trim(),
    );
  }
  return json;
}

/** id_token(JWT)은 서명 검증 없이 payload만 디코드한다 — HTTPS로 직접 받은 우리 자신의 토큰이라
 * 위조 가능성이 없고, sub 클레임(본인 userId)만 꺼내 쓰는 용도라 검증이 필요하지 않다. */
function decodeUserIdFromIdToken(idToken: string): string {
  const payloadSegment = idToken.split('.')[1];
  if (!payloadSegment) throw new Error('[oauth] id_token 형식이 올바르지 않습니다.');
  const json = Buffer.from(payloadSegment, 'base64url').toString('utf8');
  const payload = JSON.parse(json) as { sub?: string };
  if (!payload.sub) throw new Error('[oauth] id_token에 sub 클레임이 없습니다.');
  return payload.sub;
}

function toTokenRecord(res: TokenResponse, previous?: TokenRecord): TokenRecord {
  const expiresInSec = typeof res.expires_in === 'string' ? Number(res.expires_in) : res.expires_in;
  const now = Date.now();
  const userId = res.id_token ? decodeUserIdFromIdToken(res.id_token) : previous?.userId;
  if (!userId) {
    throw new Error(
      '[oauth] 본인 userId를 확인할 수 없습니다. id_token이 응답에 없습니다 (openid scope 승인 여부를 Console에서 확인하세요).',
    );
  }
  // rotation이 꺼져 있으면 응답에 refresh_token이 안 온다 — 기존 값을 그대로 유지한다
  const refreshToken = res.refresh_token ?? previous?.refreshToken ?? '';
  const rotated = Boolean(res.refresh_token) && res.refresh_token !== previous?.refreshToken;
  // 값이 실제로 바뀔 때만 90일 시계를 리셋한다. 단순 access token 갱신으로는 리셋하지 않는다.
  const refreshTokenIssuedAt = previous && !rotated ? previous.refreshTokenIssuedAt : now;
  return {
    accessToken: res.access_token,
    refreshToken,
    expiresAt: now + expiresInSec * 1000,
    scope: res.scope,
    obtainedAt: now,
    refreshTokenIssuedAt,
    userId,
  };
}

export async function exchangeCodeForToken(code: string): Promise<TokenRecord> {
  const config = getConfig();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });
  const res = await requestToken(body);
  return toTokenRecord(res);
}

export async function refreshAccessToken(previous: TokenRecord): Promise<TokenRecord> {
  const config = getConfig();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: previous.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const res = await requestToken(body);
  return toTokenRecord(res, previous);
}
