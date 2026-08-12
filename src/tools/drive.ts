import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { worksFetch, worksJson, getAccessToken, getSelfUserId } from '../client.js';

// 문서상 단일 파일 상한. 넘기면 uploadUrl 발급 단계에서 거부된다.
const MAX_FILE_SIZE = 10_737_418_240;

interface DriveFile {
  fileId: string;
  parentFileId: string;
  fileName: string;
  filePath: string;
  // 실측 결과 폴더는 'FOLDER', 일반 파일은 확장자 계열 값('DOC' 등)이 온다 — 'FILE'이 아니다.
  fileType: string;
  fileSize: number;
  createdTime: string;
  modifiedTime: string;
}

interface DriveListResponse {
  files: DriveFile[];
  responseMetaData?: { nextCursor?: string };
}

interface UploadUrlResponse {
  uploadUrl: string;
  offset: number;
}

function trimFile(file: DriveFile): Record<string, unknown> {
  return {
    fileId: file.fileId,
    fileName: file.fileName,
    isFolder: file.fileType === 'FOLDER',
    fileSize: file.fileSize,
    filePath: file.filePath,
    modifiedTime: file.modifiedTime,
  };
}

export function registerDriveTools(server: McpServer): void {
  server.registerTool(
    'works_drive_list',
    {
      title: '내 드라이브 목록',
      description:
        '내 드라이브의 파일·폴더 목록을 조회한다. folderId를 비우면 최상위(루트)를 본다. ' +
        '하위 폴더를 보려면 결과의 fileId를 folderId로 넘긴다. ' +
        'works_drive_upload에 쓸 folderId를 여기서 얻는다.',
      inputSchema: z.object({
        folderId: z.string().optional().describe('생략하면 루트. 이 목록의 fileId를 넘기면 그 폴더 안을 본다'),
        cursor: z.string().optional().describe('이어보기용. 이전 응답의 nextCursor'),
      }),
    },
    async ({ folderId, cursor }) => {
      const userId = await getSelfUserId();
      const base = folderId
        ? `/users/${userId}/drive/files/${folderId}/children`
        : `/users/${userId}/drive/files`;
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const res = await worksJson<DriveListResponse>(`${base}${qs}`);
      const summary = {
        files: res.files.map(trimFile),
        nextCursor: res.responseMetaData?.nextCursor,
      };
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    },
  );

  server.registerTool(
    'works_drive_upload',
    {
      title: '내 드라이브에 파일 업로드',
      description:
        '로컬 파일을 내 드라이브에 올린다. folderId를 비우면 루트에 올라간다(folderId는 works_drive_list로 얻는다). ' +
        '기본값은 이름이 겹치면 덮어쓰지 않고 접미사를 붙여 새 파일로 만든다 — 덮어쓰려면 overwrite:true를 명시한다.',
      inputSchema: z.object({
        filePath: z.string().describe('올릴 로컬 파일의 절대 경로'),
        folderId: z.string().optional().describe('대상 폴더의 fileId. 생략하면 루트'),
        fileName: z.string().min(1).max(200).optional().describe('드라이브에 저장될 이름. 생략하면 로컬 파일명'),
        overwrite: z.boolean().optional().describe('true면 같은 이름 파일을 덮어쓴다. 기본 false'),
      }),
    },
    async ({ filePath, folderId, fileName, overwrite }) => {
      if (!fs.existsSync(filePath)) {
        throw new Error(`[works_drive_upload] 파일이 없습니다: ${filePath}`);
      }
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        throw new Error(`[works_drive_upload] 폴더는 올릴 수 없습니다: ${filePath}`);
      }
      if (stat.size > MAX_FILE_SIZE) {
        throw new Error(
          `[works_drive_upload] 파일이 너무 큽니다 (${stat.size} bytes). 상한은 ${MAX_FILE_SIZE} bytes입니다.`,
        );
      }

      const userId = await getSelfUserId();
      const targetName = fileName ?? path.basename(filePath);

      // 1단계: 업로드 URL 발급. 폴더 ID를 붙이지 않으면 서버가 parentKey를 "root"로 잡는다.
      const initPath = folderId
        ? `/users/${userId}/drive/files/${folderId}`
        : `/users/${userId}/drive/files`;
      const init = await worksJson<UploadUrlResponse>(initPath, {
        method: 'POST',
        body: JSON.stringify({
          fileName: targetName,
          fileSize: stat.size,
          overwrite: overwrite ?? false,
          suffixOnDuplicate: !overwrite,
        }),
      });

      // 2단계: 발급받은 절대 URL로 원본 바이트를 그대로 PUT한다. 응답 201에 생성된 파일 메타가 실려온다.
      // 파일 전체를 메모리에 올린다 — 상한이 10GB지만 실사용은 그보다 훨씬 작다고 보고 단순하게 간다.
      const bytes = fs.readFileSync(filePath);
      const res = await worksFetch(init.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes,
      });
      const created = (await res.json()) as DriveFile;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { uploaded: trimFile(created), from: filePath },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'works_drive_download',
    {
      title: '내 드라이브 파일 내려받기',
      description:
        '드라이브의 파일을 로컬 폴더로 내려받는다. fileId는 works_drive_list로 얻는다. ' +
        '저장 이름은 드라이브에 있는 이름을 그대로 쓴다(saveAs로 바꿀 수 있다). ' +
        '같은 이름이 이미 있으면 덮어쓰지 않고 실패한다 — 덮어쓰려면 overwrite:true를 명시한다.',
      inputSchema: z.object({
        fileId: z.string().describe('works_drive_list에서 얻은 파일의 fileId'),
        saveDir: z.string().describe('저장할 로컬 폴더의 절대 경로'),
        saveAs: z.string().min(1).optional().describe('저장할 파일명. 생략하면 드라이브의 이름'),
        overwrite: z.boolean().optional().describe('true면 같은 이름 파일을 덮어쓴다. 기본 false'),
      }),
    },
    async ({ fileId, saveDir, saveAs, overwrite }) => {
      if (!fs.existsSync(saveDir)) {
        throw new Error(`[works_drive_download] 폴더가 없습니다: ${saveDir}`);
      }
      const userId = await getSelfUserId();

      // 이름과 크기를 먼저 받아둔다. 크기는 아래에서 받은 바이트가 온전한지 검증하는 데 쓴다.
      const meta = await worksJson<DriveFile>(`/users/${userId}/drive/files/${fileId}`);
      if (meta.fileType === 'FOLDER') {
        throw new Error(`[works_drive_download] 폴더는 내려받을 수 없습니다: ${meta.fileName}`);
      }

      const dest = path.join(saveDir, saveAs ?? meta.fileName);
      if (!overwrite && fs.existsSync(dest)) {
        throw new Error(
          `[works_drive_download] 이미 있는 파일입니다: ${dest}. 덮어쓰려면 overwrite:true로 다시 호출하세요.`,
        );
      }

      // download는 스토리지 도메인으로 302를 준다. fetch는 표준대로 교차 도메인 리다이렉트에서
      // Authorization을 떼어버리는데 스토리지 쪽은 그 헤더를 요구한다 — 직접 따라가며 토큰을 다시 붙인다.
      const config = getConfig();
      const tokens = await getAccessToken();
      const headers = { Authorization: `Bearer ${tokens.accessToken}` };
      const first = await fetch(
        `${config.apiBase}/v1.0/users/${userId}/drive/files/${fileId}/download`,
        { headers, redirect: 'manual' },
      );
      const location = first.headers.get('location');
      const res = location ? await fetch(location, { headers }) : first;
      if (!res.ok) {
        throw new Error(`[works_drive_download] 내려받기 실패 (${res.status}): ${meta.fileName}`);
      }

      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length !== meta.fileSize) {
        throw new Error(
          `[works_drive_download] 크기가 맞지 않아 저장하지 않았습니다. ` +
            `기대 ${meta.fileSize} bytes, 받은 것 ${bytes.length} bytes.`,
        );
      }
      fs.writeFileSync(dest, bytes);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ downloaded: trimFile(meta), savedTo: dest }, null, 2),
          },
        ],
      };
    },
  );
}
