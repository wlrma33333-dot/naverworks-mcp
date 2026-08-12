import http from 'node:http';
import { exec } from 'node:child_process';
import { getConfig } from '../config.js';
import { buildAuthorizeUrl, randomState, exchangeCodeForToken } from '../auth/oauth.js';
import { writeTokens } from '../auth/store.js';

const TIMEOUT_MS = 5 * 60 * 1000;

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.error('[login] 브라우저 자동 실행에 실패했습니다. 아래 URL을 직접 열어주세요.');
    }
  });
}

function htmlPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:sans-serif;padding:2rem"><h2>${title}</h2><p>${message}</p></body></html>`;
}

async function main(): Promise<void> {
  const config = getConfig();
  const state = randomState();
  const authorizeUrl = buildAuthorizeUrl(state);

  console.log('[login] 브라우저에서 네이버웍스 로그인 화면을 엽니다...');
  console.log(`[login] 자동으로 열리지 않으면 아래 주소를 직접 브라우저에 붙여넣으세요:\n${authorizeUrl}\n`);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error(`${TIMEOUT_MS / 1000}초 안에 로그인이 완료되지 않았습니다.`));
    }, TIMEOUT_MS);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${config.loginPort}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get('error');
      const returnedState = url.searchParams.get('state');
      const code = url.searchParams.get('code');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(
          htmlPage('로그인 실패', `네이버웍스가 인증을 거부했습니다: ${error}`),
        );
        clearTimeout(timeout);
        server.close();
        reject(new Error(`인증 서버가 거부했습니다: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(
          htmlPage('로그인 실패', 'state 값이 일치하지 않습니다. 다시 시도해주세요.'),
        );
        clearTimeout(timeout);
        server.close();
        reject(new Error('state 불일치 (CSRF 방지 검증 실패)'));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(
          htmlPage('로그인 실패', 'authorization code가 없습니다.'),
        );
        clearTimeout(timeout);
        server.close();
        reject(new Error('콜백에 code가 없습니다.'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        htmlPage('로그인 완료', '이 창은 닫으셔도 됩니다.'),
      );

      clearTimeout(timeout);
      server.close();

      exchangeCodeForToken(code)
        .then((tokens) => {
          writeTokens(tokens);
          console.log(`[login] 로그인 완료. scope: ${tokens.scope}`);
          console.log(`[login] userId: ${tokens.userId}`);
          resolve();
        })
        .catch(reject);
    });

    server.listen(config.loginPort, () => {
      openBrowser(authorizeUrl);
    });
  });
}

main().catch((err) => {
  console.error(`[login] 실패: ${(err as Error).message}`);
  process.exitCode = 1;
});
