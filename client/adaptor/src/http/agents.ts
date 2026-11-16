import type { IncomingMessage, ServerResponse } from 'node:http';
import { APIError } from '../model/errors.ts';
import { Agents } from '../service/agents.ts';
import { body, json } from './json.ts';

export async function handleAgents(request: IncomingMessage, response: ServerResponse, url: URL, agents: Agents) {
  const method = request.method;
  if (method === 'GET' && url.pathname === '/agents') return json(response, 200, { agents: agents.list() });
  const match = /^\/agents\/([^/]+)(?:\/(reauthenticate|inbox))?$/.exec(url.pathname);
  const id = match?.[1];
  if (id) agents.require(id);
  if (method === 'POST' && (url.pathname === '/agents' || match?.[2] === 'reauthenticate')) {
    const input = await body(request);
    if (typeof input.username !== 'string' || typeof input.password !== 'string' || !input.username || !input.password) {
      throw new APIError(400, 'INVALID_REQUEST', '请填写账号和密码');
    }
    return json(response, id ? 200 : 201, { agent: await agents.connect(input.username, input.password, id) });
  }
  if (id && !match?.[2] && method === 'PATCH') {
    const input = await body(request);
    if (typeof input.enabled !== 'boolean') throw new APIError(400, 'INVALID_REQUEST', 'enabled 必须是布尔值');
    return json(response, 200, { agent: agents.enable(id, input.enabled) });
  }
  if (id && match?.[2] === 'inbox' && method === 'GET') {
    const before = Number(url.searchParams.get('before_id') ?? Number.MAX_SAFE_INTEGER);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new APIError(400, 'INVALID_REQUEST', '分页参数无效');
    }
    return json(response, 200, agents.inbox(id, before, limit));
  }
  return false;
}
