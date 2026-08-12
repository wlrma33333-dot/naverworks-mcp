import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { worksJson, getSelfUserId } from '../client.js';

const BODY_CHUNK_SIZE = 4000;

interface MailFolder {
  folderId: number;
  folderType: 'S' | 'U';
  folderName: string;
  unreadMailCount: number;
  mailCount: number;
}

interface MailFoldersResponse {
  mailFolders: MailFolder[];
}

// mailId는 실측 결과 숫자다(문서는 명시하지 않는다) — 호출 쪽에서 문자열로 와도 받아주도록 유니온으로 둔다.
type MailId = string | number;

interface MailSummary {
  mailId: MailId;
  from: { name?: string; email?: string };
  subject: string;
  receivedTime: string;
  status: 'Read' | 'Unread';
}

interface MailListResponse {
  mails: MailSummary[];
  folderName?: string;
  totalCount?: number;
  unreadCount?: number;
  responseMetaData?: { nextCursor?: string };
}

interface MailDetail {
  mailId: MailId;
  folderId: number;
  status: string;
  from: { name?: string; email?: string };
  to?: string;
  cc?: string;
  subject: string;
  body: string;
  receivedTime?: string;
  sentTime?: string;
}

interface Attachment {
  attachmentId: string;
  filename: string;
  contentType?: string;
  size?: number;
}

// 실측 결과 { mail: {...}, attachments: [...] } 로 감싸져 있다 — 문서와 일치했다.
interface MailGetResponse {
  mail: MailDetail;
  attachments?: Attachment[];
}

function trimMail(mail: MailSummary): Record<string, unknown> {
  return {
    mailId: mail.mailId,
    from: mail.from,
    subject: mail.subject,
    receivedTime: mail.receivedTime,
    status: mail.status,
  };
}

export function registerMailTools(server: McpServer): void {
  server.registerTool(
    'works_mail_folders',
    {
      title: '메일함 목록',
      description:
        '내 메일함 목록을 조회한다. 각 메일함의 folderId와 안읽은/전체 개수를 얻는다. works_mail_list에 쓸 folderId를 여기서 얻는다. ' +
        '메일에는 검색 API가 없다 — 특정 메일을 찾으려면 works_mail_list로 범위를 좁혀 훑어야 한다.',
      inputSchema: z.object({}),
    },
    async () => {
      const userId = await getSelfUserId();
      const res = await worksJson<MailFoldersResponse>(`/users/${userId}/mail/mailfolders`);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.registerTool(
    'works_mail_list',
    {
      title: '메일함의 메일 목록',
      description:
        '지정한 메일함의 메일 목록을 조회한다(제목/발신자/시각/읽음여부만 — 본문은 works_mail_read로). ' +
        'folderId는 works_mail_folders로 얻는다.',
      inputSchema: z.object({
        folderId: z.number().int().describe('works_mail_folders에서 얻은 메일함 ID'),
        count: z.number().int().min(1).max(200).optional().describe('기본 30'),
        cursor: z.string().optional(),
        isUnread: z.boolean().optional().describe('true면 안읽은 메일만'),
      }),
    },
    async ({ folderId, count, cursor, isUnread }) => {
      const userId = await getSelfUserId();
      const params = new URLSearchParams();
      if (count) params.set('count', String(count));
      if (cursor) params.set('cursor', cursor);
      if (isUnread !== undefined) params.set('isUnread', String(isUnread));
      const qs = params.toString();
      const res = await worksJson<MailListResponse>(
        `/users/${userId}/mail/mailfolders/${folderId}/children${qs ? `?${qs}` : ''}`,
      );
      const summary = {
        folderName: res.folderName,
        totalCount: res.totalCount,
        unreadCount: res.unreadCount,
        mails: res.mails.map(trimMail),
        nextCursor: res.responseMetaData?.nextCursor,
      };
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    },
  );

  server.registerTool(
    'works_mail_read',
    {
      title: '메일 상세 읽기',
      description:
        '메일 하나를 mailId로 읽는다. 본문이 길면 4000자에서 잘리고 truncated:true가 표시된다 — ' +
        '더 읽으려면 nextOffset 값으로 offset을 지정해 다시 호출한다. ' +
        '실측 결과 이 API는 실제 메일 클라이언트처럼 호출 즉시 해당 메일을 읽음 처리하는 부수효과가 있다(문서에 명시되지 않음).',
      inputSchema: z.object({
        mailId: z.union([z.string(), z.number()]),
        offset: z.number().int().min(0).optional().describe('이어 읽기 시작 위치. 기본 0'),
      }),
    },
    async ({ mailId, offset }) => {
      const userId = await getSelfUserId();
      const res = await worksJson<MailGetResponse>(`/users/${userId}/mail/${mailId}`);
      const start = offset ?? 0;
      const fullBody = res.mail.body ?? '';
      const chunk = fullBody.slice(start, start + BODY_CHUNK_SIZE);
      const truncated = start + chunk.length < fullBody.length;
      const result = {
        mailId: res.mail.mailId,
        from: res.mail.from,
        to: res.mail.to,
        cc: res.mail.cc,
        subject: res.mail.subject,
        receivedTime: res.mail.receivedTime,
        body: chunk,
        truncated,
        nextOffset: truncated ? start + chunk.length : undefined,
        bodyTotalLength: fullBody.length,
        attachments: res.attachments?.map((a) => ({ attachmentId: a.attachmentId, filename: a.filename, size: a.size })),
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'works_mail_unread_count',
    {
      title: '안읽은 메일 개수',
      description: '전체 메일함 기준 안읽은 메일 개수를 조회한다.',
      inputSchema: z.object({}),
    },
    async () => {
      const userId = await getSelfUserId();
      const res = await worksJson<{ count: number }>(`/users/${userId}/mail/unread-count`);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.registerTool(
    'works_mail_mark',
    {
      title: '메일 읽음/중요 표시',
      description: '메일을 읽음/안읽음, 중요/일반으로 표시한다. 지정하지 않은 값은 바뀌지 않는다.',
      inputSchema: z.object({
        mailId: z.union([z.string(), z.number()]),
        read: z.boolean().optional().describe('true=읽음, false=안읽음'),
        important: z.boolean().optional().describe('true=중요 표시, false=해제'),
      }),
    },
    async ({ mailId, read, important }) => {
      const userId = await getSelfUserId();
      const body = {
        ...(read !== undefined && { readStatus: read }),
        ...(important !== undefined && { markStatus: important }),
      };
      await worksJson(`/users/${userId}/mail/${mailId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      return { content: [{ type: 'text', text: `mailId ${mailId} 표시를 변경했습니다.` }] };
    },
  );

  server.registerTool(
    'works_mail_send',
    {
      title: '메일 발송',
      description:
        '메일을 보낸다. 되돌릴 수 없고 초안 저장 기능도 없다 — 그래서 confirmed 인자를 필수로 받는다. ' +
        'confirmed는 수신자·제목·본문 전문을 사용자에게 그대로 보여주고 명시적으로 승인받은 뒤에만 true로 채운다. ' +
        '내 이름·내 주소로 나가고 보낸메일함에 남으며, 답장은 내 받은편지함으로 온다.',
      inputSchema: z.object({
        to: z.string().describe('수신자 이메일. 여러 명이면 세미콜론(;)으로 구분'),
        cc: z.string().optional().describe('참조. 세미콜론으로 구분'),
        subject: z.string().max(180).describe('제목 (최대 180자)'),
        body: z.string().describe('본문 (텍스트)'),
        userName: z.string().optional().describe('발신자 표시 이름'),
        confirmed: z
          .boolean()
          .describe(
            '반드시 true. 사용자에게 수신자·제목·본문 전문을 보여주고 명시적 승인을 받은 뒤에만 true를 채울 것.',
          ),
      }),
    },
    async ({ to, cc, subject, body, userName, confirmed }) => {
      if (!confirmed) {
        throw new Error(
          '[works_mail_send] confirmed가 false입니다. 수신자·제목·본문 전문을 사용자에게 보여주고 ' +
            '승인을 받은 뒤에만 confirmed:true로 다시 호출하세요. 승인 없이는 발송하지 않습니다.',
        );
      }
      const userId = await getSelfUserId();
      const payload = {
        to,
        ...(cc && { cc }),
        subject,
        body,
        contentType: 'text',
        ...(userName && { userName }),
        isSaveSentMail: true,
      };
      const res = await worksJson(`/users/${userId}/mail`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    },
  );
}
