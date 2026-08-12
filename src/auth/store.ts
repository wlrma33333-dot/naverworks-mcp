import fs from 'node:fs';
import { paths, ensureTokenDir } from '../config.js';

export interface TokenRecord {
  accessToken: string;
  refreshToken: string;
  /** access token 만료 시각, epoch ms */
  expiresAt: number;
  scope: string;
  /** 이 access token이 발급된 시각. accessToken을 갱신할 때마다 바뀐다. */
  obtainedAt: number;
  /** 지금의 refreshToken 값이 발급된 시각. rotation으로 실제 값이 바뀔 때만 갱신되고,
   * 단순 access token 갱신으로는 바뀌지 않는다 — 90일 만료 계산의 기준이 된다. */
  refreshTokenIssuedAt: number;
  /** id_token의 sub 클레임에서 뽑은 본인 userId. 로그인 시 한 번 확정되며 이후 갱신에도 유지된다. */
  userId: string;
}

export function readTokens(): TokenRecord | null {
  try {
    const raw = fs.readFileSync(paths.tokenFile, 'utf8');
    return JSON.parse(raw) as TokenRecord;
  } catch {
    return null;
  }
}

export function writeTokens(tokens: TokenRecord): void {
  ensureTokenDir();
  fs.writeFileSync(paths.tokenFile, JSON.stringify(tokens, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export function clearTokens(): void {
  try {
    fs.unlinkSync(paths.tokenFile);
  } catch {
    // 이미 없으면 상관없다
  }
}
