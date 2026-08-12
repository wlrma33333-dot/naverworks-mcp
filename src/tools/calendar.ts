import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { worksJson, getSelfUserId } from '../client.js';
import { nowKstIso, addDaysKstIso } from '../util/time.js';

/** 네이버웍스 캘린더 API의 시작/종료 시각 표현. date는 종일 일정, dateTime+timeZone은 시간 일정. */
interface EventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

/** 문서에 없는 필드(organizer, viewUrl 등)도 잃지 않도록 인덱스 시그니처로 통째로 보존한다.
 * PUT이 전체 교체라서, 모르는 필드를 날려버리면 그게 곧 데이터 유실이다. */
interface EventComponent {
  eventId?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
  categoryId?: string;
  recurrence?: unknown[];
  transparency?: string;
  visibility?: string;
  attendees?: unknown[];
  reminders?: unknown[];
  priority?: number;
  [key: string]: unknown;
}

interface EventEnvelope {
  eventComponents: EventComponent[];
  organizerCalendarId?: string;
}

interface EventListResponse {
  events: EventEnvelope[];
  responseMetaData?: { nextCursor?: string };
}

interface CalendarPersonal {
  calendarId: string;
  calendarName: string;
  isShowOnLNBList?: boolean;
  displayOrder?: number;
}

interface CalendarPersonalsResponse {
  calendarPersonals: CalendarPersonal[];
  responseMetaData?: { nextCursor?: string };
}

const eventTimeSchema = z
  .object({
    date: z.string().optional().describe('종일 일정. YYYY-MM-DD'),
    dateTime: z.string().optional().describe('시간 일정. YYYY-MM-DDTHH:mm:ss (예: 2026-08-13T09:00:00)'),
    timeZone: z.string().optional().describe('기본값 Asia/Seoul'),
  })
  .describe('date 또는 dateTime 중 하나를 채운다. 상대 표현("내일", "오후 3시")은 호출 전에 ISO로 직접 변환할 것.');

/** 목록 조회 응답을 요약한다 — 통째로 반환하면 컨텍스트가 낭비된다. 상세는 works_event_get으로. */
function summarizeEvent(envelope: EventEnvelope): Record<string, unknown> {
  const first = envelope.eventComponents[0];
  return {
    eventId: first?.eventId,
    summary: first?.summary,
    start: first?.start,
    end: first?.end,
    location: first?.location,
    calendarId: envelope.organizerCalendarId,
    hasMultipleComponents: envelope.eventComponents.length > 1, // 반복/예외 일정 여부 힌트
  };
}

export function registerCalendarTools(server: McpServer): void {
  server.registerTool(
    'works_calendar_list',
    {
      title: '내 캘린더 목록',
      description: '내가 가진 캘린더 목록(공유 캘린더 포함)을 조회한다. 각 캘린더의 calendarId와 이름을 얻는다.',
      inputSchema: z.object({
        count: z.number().int().min(1).max(50).optional().describe('기본 50'),
        cursor: z.string().optional().describe('이전 응답의 responseMetaData.nextCursor'),
      }),
    },
    async ({ count, cursor }) => {
      const userId = await getSelfUserId();
      const query = new URLSearchParams();
      if (count) query.set('count', String(count));
      if (cursor) query.set('cursor', cursor);
      const qs = query.toString();
      const res = await worksJson<CalendarPersonalsResponse>(
        `/users/${userId}/calendar-personals${qs ? `?${qs}` : ''}`,
      );
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.registerTool(
    'works_event_list',
    {
      title: '기간별 일정 목록',
      description:
        '지정한 기간의 기본 캘린더 일정을 조회한다. 기간을 지정하지 않으면 지금부터 7일간을 기본으로 본다. ' +
        '응답에 nowKst(현재 KST 시각)를 함께 실어 "내일", "다음 주" 같은 상대 시간 계산의 기준으로 삼을 수 있게 한다.',
      inputSchema: z.object({
        fromDateTime: z.string().optional().describe('ISO. 생략 시 지금'),
        untilDateTime: z.string().optional().describe('ISO. 생략 시 fromDateTime + 7일'),
      }),
    },
    async ({ fromDateTime, untilDateTime }) => {
      const userId = await getSelfUserId();
      const now = new Date();
      const from = fromDateTime ?? nowKstIso();
      const until = untilDateTime ?? addDaysKstIso(now, 7);
      const query = new URLSearchParams({ fromDateTime: from, untilDateTime: until });
      const res = await worksJson<EventListResponse>(`/users/${userId}/calendar/events?${query}`);
      const summary = {
        nowKst: nowKstIso(),
        range: { fromDateTime: from, untilDateTime: until },
        count: res.events.length,
        events: res.events.map(summarizeEvent),
      };
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    },
  );

  server.registerTool(
    'works_event_search',
    {
      title: '일정 검색',
      description: '키워드로 일정을 검색한다. 검색 범위는 기간을 지정하지 않으면 전체 캘린더다.',
      inputSchema: z.object({
        query: z.string().min(2).max(100).describe('검색어 (2~100자)'),
        queryFilters: z
          .array(z.enum(['summary', 'attendee', 'location', 'description']))
          .optional()
          .describe('검색 대상 필드. 생략 시 전체'),
        startTime: z.string().optional().describe('ISO. 검색 기간 시작'),
        endTime: z.string().optional().describe('ISO. 검색 기간 끝'),
        count: z.number().int().min(1).max(100).optional().describe('기본 50'),
        cursor: z.string().optional(),
      }),
    },
    async ({ query, queryFilters, startTime, endTime, count, cursor }) => {
      const userId = await getSelfUserId();
      const params = new URLSearchParams({ query });
      if (queryFilters?.length) params.set('queryFilters', queryFilters.join(','));
      if (startTime) params.set('startTime', startTime);
      if (endTime) params.set('endTime', endTime);
      if (count) params.set('count', String(count));
      if (cursor) params.set('cursor', cursor);
      const res = await worksJson<EventListResponse>(`/users/${userId}/calendars/events/search?${params}`);
      const summary = {
        nowKst: nowKstIso(),
        count: res.events.length,
        events: res.events.map(summarizeEvent),
        nextCursor: res.responseMetaData?.nextCursor,
      };
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    },
  );

  server.registerTool(
    'works_event_get',
    {
      title: '일정 상세 조회',
      description: '일정 하나를 eventId로 상세 조회한다. 수정 전에 현재 값을 확인할 때도 쓴다.',
      inputSchema: z.object({
        eventId: z.string(),
      }),
    },
    async ({ eventId }) => {
      const userId = await getSelfUserId();
      const res = await worksJson<EventEnvelope>(`/users/${userId}/calendar/events/${eventId}`);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.registerTool(
    'works_event_create',
    {
      title: '일정 생성',
      description:
        '기본 캘린더에 일정을 하나 만든다. 참석자 지정은 지원하지 않는다(대외 행위라 2단계로 미뤘다) — ' +
        '본인 전용 일정만 만들 수 있다. 상대 시간 표현("내일 오후 3시")은 호출 전에 ISO로 직접 변환할 것.',
      inputSchema: z.object({
        summary: z.string().describe('일정 제목'),
        description: z.string().max(5000).optional(),
        location: z.string().optional(),
        start: eventTimeSchema,
        end: eventTimeSchema.optional(),
        priority: z.number().int().min(0).max(9).optional(),
        notifyAttendees: z
          .boolean()
          .default(false)
          .describe('알림 발송 여부(sendNotification). 참석자를 지정하지 않으므로 기본값 그대로 두면 된다.'),
      }),
    },
    async ({ summary, description, location, start, end, priority, notifyAttendees }) => {
      const userId = await getSelfUserId();
      const component: EventComponent = { summary, description, location, start, end, priority };
      const res = await worksJson<EventEnvelope>(`/users/${userId}/calendar/events`, {
        method: 'POST',
        body: JSON.stringify({ eventComponents: [component], sendNotification: notifyAttendees }),
      });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.registerTool(
    'works_event_update',
    {
      title: '일정 수정',
      description:
        '일정을 수정한다. 이 API는 PUT(전체 교체)라서, 내부적으로 먼저 현재 값을 GET으로 읽고 ' +
        '지정한 필드만 덮어쓴 뒤 전체를 다시 보낸다 — 그래서 이 툴은 제목만 바꿔도 장소·참석자·알림이 날아가지 않는다. ' +
        '반복 일정(eventComponents가 여러 개인 일정)은 예외 처리가 복잡해 이 단계에서는 지원하지 않고 에러로 거부한다.',
      inputSchema: z.object({
        eventId: z.string(),
        summary: z.string().optional(),
        description: z.string().max(5000).optional(),
        location: z.string().optional(),
        start: eventTimeSchema.optional(),
        end: eventTimeSchema.optional(),
        priority: z.number().int().min(0).max(9).optional(),
        notifyAttendees: z.boolean().default(false),
      }),
    },
    async ({ eventId, summary, description, location, start, end, priority, notifyAttendees }) => {
      const userId = await getSelfUserId();
      const current = await worksJson<EventEnvelope>(`/users/${userId}/calendar/events/${eventId}`);

      if (current.eventComponents.length !== 1) {
        throw new Error(
          `[works_event_update] 이 일정은 eventComponents가 ${current.eventComponents.length}개입니다 ` +
            '(반복/예외 일정으로 보입니다). 데이터 유실 위험이 있어 이 툴로는 수정할 수 없습니다. 웍스 앱에서 직접 수정하세요.',
        );
      }

      const merged: EventComponent = {
        ...current.eventComponents[0],
        ...(summary !== undefined && { summary }),
        ...(description !== undefined && { description }),
        ...(location !== undefined && { location }),
        ...(start !== undefined && { start }),
        ...(end !== undefined && { end }),
        ...(priority !== undefined && { priority }),
      };

      const res = await worksJson<EventEnvelope>(`/users/${userId}/calendar/events/${eventId}`, {
        method: 'PUT',
        body: JSON.stringify({ eventComponents: [merged], sendNotification: notifyAttendees }),
      });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    },
  );
}
