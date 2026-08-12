import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

function loadDotenv(): void {
  const envPath = path.resolve(import.meta.dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.error(`[config] .env 로드 실패: ${(err as Error).message}`);
  }
}

loadDotenv();

const REQUIRED_KEYS = ['WORKS_CLIENT_ID', 'WORKS_CLIENT_SECRET'] as const;

/** 필수 env 중 비어있는 키 이름을 반환한다. 빈 배열이면 전부 채워진 것이다. 값 자체는 절대 노출하지 않는다. */
export function missingEnvKeys(): string[] {
  return REQUIRED_KEYS.filter((key) => !process.env[key]);
}

export interface WorksConfig {
  clientId: string;
  clientSecret: string;
  apiBase: string;
  authBase: string;
  redirectUri: string;
  loginPort: number;
}

/** 필수 env가 없으면 던진다. 인증·API 호출 경로에서만 쓴다. */
export function getConfig(): WorksConfig {
  const missing = missingEnvKeys();
  if (missing.length > 0) {
    throw new Error(
      `[config] 환경변수가 없습니다: ${missing.join(', ')}. .env.example을 참고해 .env를 채워주세요.`,
    );
  }
  return {
    clientId: process.env.WORKS_CLIENT_ID!,
    clientSecret: process.env.WORKS_CLIENT_SECRET!,
    apiBase: (process.env.WORKS_API_BASE ?? 'https://www.worksapis.com').replace(/\/$/, ''),
    authBase: (process.env.WORKS_AUTH_BASE ?? 'https://auth.worksmobile.com').replace(/\/$/, ''),
    redirectUri: 'http://localhost:9876/callback',
    loginPort: 9876,
  };
}

export const paths = {
  tokenDir: path.join(os.homedir(), 'AppData', 'Roaming', 'naverworks-mcp'),
  get tokenFile(): string {
    return path.join(this.tokenDir, 'tokens.json');
  },
} as const;

export function ensureTokenDir(): void {
  fs.mkdirSync(paths.tokenDir, { recursive: true });
}
