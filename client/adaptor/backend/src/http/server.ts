import { createServer } from 'node:http';
import type { Config } from '../config/config.ts';
import { APIError } from '../model/errors.ts';
import { Agents } from '../service/agents.ts';
import { Sessions } from '../service/sessions.ts';
import { handleAgents } from './agents.ts';
import { handleSessions } from './sessions.ts';
import { json } from './json.ts';

export function createApp(config: Config, agents: Agents, sessions: Sessions, checkHealth: () => void) {
  return createServer(async (request, response) => {
    try {
      if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
        throw new APIError(403, 'FORBIDDEN', '只接受同源请求');
      }
      const url = new URL(request.url!, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        checkHealth(); json(response, 200, { status: 'ok' }); return;
      }
      if (request.method === 'GET' && url.pathname === '/config') {
        json(response, 200, { adaptor_id: config.adaptor_id, im_base_url: config.im_base_url, trigger_ws_url: config.trigger_ws_url }); return;
      }
      if (await handleSessions(request, response, url, sessions)) return;
      if (await handleAgents(request, response, url, agents)) return;
      throw new APIError(404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      const known = error instanceof APIError;
      if (!known) console.error('Adaptor request failed');
      json(response, known ? error.status : 500, { error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '本机服务处理失败' } });
    }
  });
}
