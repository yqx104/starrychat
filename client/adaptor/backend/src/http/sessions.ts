import type { IncomingMessage, ServerResponse } from 'node:http';
import { APIError } from '../model/errors.ts';
import { Sessions } from '../service/sessions.ts';
import { body, json } from './json.ts';

export async function handleSessions(request: IncomingMessage, response: ServerResponse, url: URL, sessions: Sessions) {
  const method = request.method;
  const match = /^\/sessions\/([^/]+)\/(abort|events|inputs\/([0-9]+)\/resolve)$/.exec(url.pathname);
  if (match) {
    const record = sessions.require(match[1]);
    if (match[2] === 'events' && method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new APIError(400, 'INVALID_REQUEST', '事件游标无效');
      const cursor = url.searchParams.get('epoch') === sessions.eventEpoch ? after : 0;
      return json(response, 200, sessions.readEvents(record.session_id, cursor));
    }
    if (match[2] === 'abort' && method === 'POST') {
      await body(request);
      return json(response, 200, await sessions.abort(record.session_id));
    }
    if (match[3] && method === 'POST') {
      const input = await body(request);
      const inputId = Number(match[3]);
      if (!Number.isSafeInteger(inputId) || inputId < 1 || input.confirmed !== true || (input.action !== 'retry' && input.action !== 'accepted')) {
        throw new APIError(400, 'INVALID_REQUEST', '需要核对原输入及 Pi 历史后确认处理方式');
      }
      await sessions.resolveInput(record.session_id, inputId, input.action);
      return json(response, 200, { status: 'ok' });
    }
  }
  const agent = /^\/agents\/([^/]+)\/(runtime|main-session)$/.exec(url.pathname);
  if (agent) {
    const id = agent[1];
    if (agent[2] === 'main-session') {
      const view = sessions.view(id);
      if (method === 'GET') return json(response, 200, view);
    } else {
      const config = sessions.runtimeConfig(id);
      if (method === 'GET') return json(response, 200, config);
      if (method === 'PATCH') return json(response, 200, await sessions.configure(id, await body(request)));
    }
  }
  return false;
}
