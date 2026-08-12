import { getConfig } from './config.js';
import { readTokens, writeTokens, type TokenRecord } from './auth/store.js';
import { refreshAccessToken } from './auth/oauth.js';
import { ReloginRequiredError, WorksApiError } from './errors.js';

const EXPIRY_SKEW_MS = 60_000;

async function getValidTokens(): Promise<TokenRecord> {
  const tokens = readTokens();
  if (!tokens) {
    throw new ReloginRequiredError('로그인된 적이 없습니다. `npm run login`으로 로그인하세요.');
  }
  if (Date.now() < tokens.expiresAt - EXPIRY_SKEW_MS) {
    return tokens;
  }
  try {
    const refreshed = await refreshAccessToken(tokens);
    writeTokens(refreshed);
    return refreshed;
  } catch (err) {
    throw new ReloginRequiredError(
      `토큰 갱신에 실패했습니다. Refresh Token이 90일 만료됐거나 다른 기기 로그인으로 무효화됐을 수 있습니다. ` +
        `\`npm run login\`으로 다시 로그인하세요. (원인: ${(err as Error).message})`,
    );
  }
}

/** 단 하나의 토큰 획득 창구. 인증이 필요한 모든 곳이 여기를 거친다. */
export async function getAccessToken(): Promise<TokenRecord> {
  return getValidTokens();
}

export async function getSelfUserId(): Promise<string> {
  const tokens = await getValidTokens();
  return tokens.userId;
}

interface WorksFetchOptions extends RequestInit {
  /** 내부용. 401 재시도 1회 제한. */
  _retried?: boolean;
}

export async function worksFetch(path: string, init: WorksFetchOptions = {}): Promise<Response> {
  const config = getConfig();
  const tokens = await getValidTokens();
  const url = path.startsWith('http') ? path : `${config.apiBase}/v1.0${path}`;

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${tokens.accessToken}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, { ...init, headers });

  if (res.status === 401 && !init._retried) {
    try {
      const refreshed = await refreshAccessToken(tokens);
      writeTokens(refreshed);
    } catch (err) {
      throw new ReloginRequiredError(
        `인증이 만료됐습니다. \`npm run login\`으로 다시 로그인하세요. (원인: ${(err as Error).message})`,
      );
    }
    return worksFetch(path, { ...init, _retried: true });
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new WorksApiError(
      `[works api] ${init.method ?? 'GET'} ${path} -> ${res.status}`,
      res.status,
      bodyText,
    );
  }

  return res;
}

export async function worksJson<T>(path: string, init: WorksFetchOptions = {}): Promise<T> {
  const res = await worksFetch(path, init);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}
