import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getConfig, missingEnvKeys } from '../config.js';
import { readTokens } from '../auth/store.js';
import { refreshAccessToken } from '../auth/oauth.js';
import { writeTokens } from '../auth/store.js';

const REFRESH_TOKEN_LIFETIME_DAYS = 90;
const REFRESH_TOKEN_WARNING_DAYS = 7;

export interface DoctorReport {
  envOk: boolean;
  missingEnvKeys: string[];
  apiBase: string;
  authBase: string;
  loggedIn: boolean;
  userId?: string;
  scope?: string;
  accessTokenValid: boolean;
  accessTokenExpiresInMin?: number;
  refreshCheckOk?: boolean;
  refreshCheckError?: string;
  refreshTokenAgeDays?: number;
  refreshTokenRemainingDays?: number;
  refreshTokenWarning: boolean;
}

/** works_doctor의 실제 점검 로직. MCP 툴과 `npm run doctor` CLI가 공유한다.
 * 자격증명 값 자체는 절대 반환하지 않는다 — 로드 여부와 결과만 담는다. */
export async function runDoctor(): Promise<DoctorReport> {
  const missing = missingEnvKeys();
  const envOk = missing.length === 0;

  if (!envOk) {
    return {
      envOk,
      missingEnvKeys: missing,
      apiBase: process.env.WORKS_API_BASE ?? 'https://www.worksapis.com',
      authBase: process.env.WORKS_AUTH_BASE ?? 'https://auth.worksmobile.com',
      loggedIn: false,
      accessTokenValid: false,
      refreshTokenWarning: false,
    };
  }

  const config = getConfig();
  const tokens = readTokens();

  if (!tokens) {
    return {
      envOk,
      missingEnvKeys: missing,
      apiBase: config.apiBase,
      authBase: config.authBase,
      loggedIn: false,
      accessTokenValid: false,
      refreshTokenWarning: false,
    };
  }

  const accessTokenValid = Date.now() < tokens.expiresAt;
  const accessTokenExpiresInMin = Math.round((tokens.expiresAt - Date.now()) / 60_000);

  let refreshCheckOk: boolean | undefined;
  let refreshCheckError: string | undefined;
  try {
    const refreshed = await refreshAccessToken(tokens);
    writeTokens(refreshed);
    refreshCheckOk = true;
  } catch (err) {
    refreshCheckOk = false;
    refreshCheckError = (err as Error).message;
  }

  const latest = readTokens() ?? tokens;
  const refreshTokenAgeDays = (Date.now() - latest.refreshTokenIssuedAt) / 86_400_000;
  const refreshTokenRemainingDays = Math.max(0, REFRESH_TOKEN_LIFETIME_DAYS - refreshTokenAgeDays);

  return {
    envOk,
    missingEnvKeys: missing,
    apiBase: config.apiBase,
    authBase: config.authBase,
    loggedIn: true,
    userId: latest.userId,
    scope: latest.scope,
    accessTokenValid,
    accessTokenExpiresInMin,
    refreshCheckOk,
    refreshCheckError,
    refreshTokenAgeDays: Math.round(refreshTokenAgeDays * 10) / 10,
    refreshTokenRemainingDays: Math.round(refreshTokenRemainingDays * 10) / 10,
    refreshTokenWarning: refreshTokenRemainingDays <= REFRESH_TOKEN_WARNING_DAYS,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];

  lines.push(`env: ${report.envOk ? 'OK' : `누락 — ${report.missingEnvKeys.join(', ')}`}`);
  lines.push(`API_BASE: ${report.apiBase}`);
  lines.push(`AUTH_BASE: ${report.authBase}`);

  if (!report.envOk) {
    lines.push('', '.env.example을 .env로 복사하고 값을 채운 뒤 다시 실행하세요.');
    return lines.join('\n');
  }

  if (!report.loggedIn) {
    lines.push('로그인: 안 됨', '', '`npm run login`으로 로그인하세요.');
    return lines.join('\n');
  }

  lines.push(`로그인: 됨 (userId: ${report.userId})`);
  lines.push(`scope: ${report.scope}`);
  lines.push(
    `access token: ${report.accessTokenValid ? '유효' : '만료'} (남은 시간 약 ${report.accessTokenExpiresInMin}분)`,
  );
  lines.push(
    `refresh token 갱신 테스트: ${report.refreshCheckOk ? '성공' : `실패 — ${report.refreshCheckError}`}`,
  );

  if (report.refreshTokenRemainingDays !== undefined) {
    lines.push(
      `refresh token 만료까지: 약 ${report.refreshTokenRemainingDays}일 (90일 중 ${report.refreshTokenAgeDays}일 경과)`,
    );
    if (report.refreshTokenWarning) {
      lines.push(`⚠ 만료가 임박했습니다. \`npm run login\`으로 재로그인을 준비하세요.`);
    }
  }

  return lines.join('\n');
}

export function registerDoctorTools(server: McpServer): void {
  server.registerTool(
    'works_doctor',
    {
      title: '네이버웍스 연동 상태 진단',
      description:
        '네이버웍스 MCP 연동의 설정 상태를 점검한다. env 로드 여부, 로그인 상태, 토큰 만료 잔여일, ' +
        'refresh token 갱신 성공 여부, 승인된 scope, 본인 userId를 한 번에 확인한다. ' +
        '다른 툴이 알 수 없는 에러를 낼 때 가장 먼저 이 툴로 원인을 좁힌다. 자격증명 값 자체는 절대 노출하지 않는다.',
      inputSchema: z.object({}),
    },
    async () => {
      const report = await runDoctor();
      return {
        content: [{ type: 'text', text: formatDoctorReport(report) }],
      };
    },
  );
}
