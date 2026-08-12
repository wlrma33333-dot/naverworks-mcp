import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { worksJson, getSelfUserId } from '../client.js';
import { nowKstIso } from '../util/time.js';

interface Assignee {
  assigneeId: string;
  assigneeName?: string;
  status: 'TODO' | 'DONE';
}

interface Task {
  taskId: string;
  title: string;
  content?: string;
  status: 'TODO' | 'DONE';
  dueDate?: string | null;
  assignorId: string;
  assignorName?: string;
  assignees: Assignee[];
  completionCondition: 'ANY_ONE' | 'MUST_ALL';
  createdTime?: string;
  modifiedTime?: string;
}

interface TaskListResponse {
  tasks: Task[];
  responseMetaData?: { nextCursor?: string };
}

interface TaskCategory {
  categoryId: string;
  categoryName: string;
}

interface TaskCategoryListResponse {
  taskCategories: TaskCategory[];
}

function summarizeTask(task: Task): Record<string, unknown> {
  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    dueDate: task.dueDate,
  };
}

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    'works_task_list',
    {
      title: '카테고리별 할일 목록',
      description:
        '지정한 카테고리의 내 할일을 조회한다. categoryId를 모르면 먼저 works_task_categories로 확인하거나, ' +
        '카테고리 구분 없이 전체를 보려면 works_task_search를 대신 쓴다.',
      inputSchema: z.object({
        categoryId: z.string().describe('works_task_categories로 확인. 기본 카테고리는 "default"'),
        status: z.enum(['TODO', 'ALL']).optional().describe('기본값 TODO(미완료만)'),
        count: z.number().int().min(0).max(100).optional().describe('기본 50'),
        cursor: z.string().optional(),
      }),
    },
    async ({ categoryId, status, count, cursor }) => {
      const userId = await getSelfUserId();
      const params = new URLSearchParams({ categoryId });
      if (status) params.set('status', status);
      if (count !== undefined) params.set('count', String(count));
      if (cursor) params.set('cursor', cursor);
      const res = await worksJson<TaskListResponse>(`/users/${userId}/tasks?${params}`);
      const summary = {
        count: res.tasks.length,
        tasks: res.tasks.map(summarizeTask),
        nextCursor: res.responseMetaData?.nextCursor,
      };
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    },
  );

  server.registerTool(
    'works_task_search',
    {
      title: '할일 검색 (전체 카테고리)',
      description:
        '카테고리 구분 없이 내 할일을 검색한다. "내 할일 전부 보여줘" 같은 요청에는 이 툴을 쓴다. ' +
        'query 없이 부를 때는 자동으로 assigneeId를 본인으로 지정해 "내 할일 전체"를 의미하게 한다.',
      inputSchema: z.object({
        query: z.string().optional().describe('제목/내용 검색어'),
        status: z.enum(['TODO', 'DONE']).optional(),
        hasDueDate: z.boolean().optional(),
        startTime: z.string().optional().describe('ISO. dueDate 검색 기간 시작'),
        endTime: z.string().optional().describe('ISO. dueDate 검색 기간 끝'),
        count: z.number().int().min(1).optional().describe('기본 50'),
        cursor: z.string().optional(),
      }),
    },
    async ({ query, status, hasDueDate, startTime, endTime, count, cursor }) => {
      const userId = await getSelfUserId();
      const params = new URLSearchParams();
      if (query) params.set('query', query);
      // query·assignorId·assignee·기간 중 하나는 있어야 하는 API 제약 — 아무것도 없으면 본인 할일 전체로 좁힌다
      if (!query && !startTime && !endTime) params.set('assigneeId', userId);
      if (status) params.set('status', status);
      if (hasDueDate !== undefined) params.set('hasDueDate', String(hasDueDate));
      if (startTime) params.set('startTime', startTime);
      if (endTime) params.set('endTime', endTime);
      if (count) params.set('count', String(count));
      if (cursor) params.set('cursor', cursor);
      const res = await worksJson<TaskListResponse>(`/users/${userId}/tasks/search?${params}`);
      const summary = {
        nowKst: nowKstIso(),
        count: res.tasks.length,
        tasks: res.tasks.map(summarizeTask),
        nextCursor: res.responseMetaData?.nextCursor,
      };
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    },
  );

  server.registerTool(
    'works_task_get',
    {
      title: '할일 상세 조회',
      description: '할일 하나를 taskId로 상세 조회한다.',
      inputSchema: z.object({ taskId: z.string() }),
    },
    async ({ taskId }) => {
      // 문서는 { task: {...} } 래핑을 명시하지만 실제 응답은 평평한 Task 객체다 — 실측으로 확인했다.
      const res = await worksJson<Task>(`/tasks/${taskId}`);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.registerTool(
    'works_task_categories',
    {
      title: '할일 카테고리 목록',
      description: '내 할일 카테고리 목록을 조회한다. works_task_list에 쓸 categoryId를 여기서 얻는다.',
      inputSchema: z.object({}),
    },
    async () => {
      const userId = await getSelfUserId();
      const res = await worksJson<TaskCategoryListResponse>(`/users/${userId}/task-categories`);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.registerTool(
    'works_task_create',
    {
      title: '할일 생성',
      description:
        '내 할일을 하나 만든다. 담당자는 항상 본인으로 고정된다 — 다른 사람에게 할일을 배정하는 기능은 ' +
        '이 툴에 없다(팀원에게 알림이 가는 대외 행위라 의도적으로 뺐다).',
      inputSchema: z.object({
        title: z.string().describe('할일 제목'),
        content: z.string().optional().describe('메모. 기본값 빈 문자열'),
        dueDate: z.string().optional().describe('YYYY-MM-DD'),
        categoryId: z.string().optional().describe('기본 카테고리에 만들려면 생략'),
      }),
    },
    async ({ title, content, dueDate, categoryId }) => {
      const userId = await getSelfUserId();
      const body = {
        assignorId: userId,
        assignees: [{ assigneeId: userId, status: 'TODO' as const }],
        title,
        content: content ?? '',
        completionCondition: 'ANY_ONE' as const,
        ...(dueDate && { dueDate }),
        ...(categoryId && { categoryId }),
      };
      const res = await worksJson<Task>(`/users/${userId}/tasks`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.registerTool(
    'works_task_update',
    {
      title: '할일 수정',
      description:
        '할일의 제목·메모·마감일을 수정한다(PATCH라 지정한 필드만 바뀐다). 담당자 재배정은 이 툴로 할 수 없다.',
      inputSchema: z.object({
        taskId: z.string(),
        title: z.string().optional(),
        content: z.string().optional(),
        dueDate: z.string().optional().describe('YYYY-MM-DD. 마감일을 없애려면 빈 문자열'),
      }),
    },
    async ({ taskId, title, content, dueDate }) => {
      const body = {
        ...(title !== undefined && { title }),
        ...(content !== undefined && { content }),
        ...(dueDate !== undefined && { dueDate }),
      };
      const res = await worksJson<Task>(`/tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.registerTool(
    'works_task_set_done',
    {
      title: '할일 완료/미완료 처리',
      description: '할일을 완료 또는 미완료로 표시한다.',
      inputSchema: z.object({
        taskId: z.string(),
        done: z.boolean().describe('true면 완료 처리, false면 미완료로 되돌린다'),
      }),
    },
    async ({ taskId, done }) => {
      const action = done ? 'complete' : 'incomplete';
      await worksJson(`/tasks/${taskId}/${action}`, { method: 'POST' });
      return { content: [{ type: 'text', text: `taskId ${taskId}를 ${done ? '완료' : '미완료'}로 처리했습니다.` }] };
    },
  );
}
