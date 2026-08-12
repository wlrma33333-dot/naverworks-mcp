import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { registerDoctorTools } from './tools/doctor.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerTaskTools } from './tools/task.js';
import { registerMailTools } from './tools/mail.js';
import { registerDriveTools } from './tools/drive.js';

// stdout은 JSON-RPC 채널이다. console.log를 여기서 쓰면 프로토콜이 깨진다 — 로그는 항상 console.error로.

serveStdio(() => {
  const server = new McpServer({ name: 'naverworks', version: '0.1.0' });
  registerDoctorTools(server);
  registerCalendarTools(server);
  registerTaskTools(server);
  registerMailTools(server);
  registerDriveTools(server);
  return server;
});
