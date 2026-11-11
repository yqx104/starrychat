import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Config } from './config.ts';
import { Store, publicAgent } from './store.ts';
import { Connections } from './connections.ts';
import { APIError, login } from './im.ts';

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new APIError(400, 'INVALID_REQUEST', '请求需要 JSON');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new APIError(413, 'INVALID_REQUEST', '请求过大');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new APIError(400, 'INVALID_REQUEST', '无效的 JSON'); }
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

export function createApp(config: Config, store: Store, connections: Connections) {
  return createServer(async (request, response) => {
    try {
      if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
        throw new APIError(403, 'FORBIDDEN', '只接受同源请求');
      }
      const url = new URL(request.url!, 'http://localhost');
      const method = request.method;
      if (method === 'GET' && url.pathname === '/healthz') {
        store.db.prepare('SELECT 1').get(); return json(response, 200, { status: 'ok' });
      }
      if (method === 'GET' && url.pathname === '/config') {
        return json(response, 200, { adaptor_id: config.adaptor_id, im_base_url: config.im_base_url, trigger_ws_url: config.trigger_ws_url });
      }
      const view = (id: string) => ({ ...publicAgent(store.agent(id)!), ...connections.status(id) });
      if (method === 'GET' && url.pathname === '/agents') {
        return json(response, 200, { agents: store.agents().map(agent => view(agent.agent_id)) });
      }
      const match = /^\/agents\/([^/]+)(?:\/(reauthenticate|inbox))?$/.exec(url.pathname);
      const id = match?.[1];
      if (id && !store.agent(id)) throw new APIError(404, 'NOT_FOUND', 'Agent 不存在');
      if (method === 'POST' && (url.pathname === '/agents' || match?.[2] === 'reauthenticate')) {
        const input = await body(request);
        if (typeof input.username !== 'string' || typeof input.password !== 'string' || !input.username || !input.password) {
          throw new APIError(400, 'INVALID_REQUEST', '请填写账号和密码');
        }
        const account = await login(config.im_base_url, input.username, input.password);
        if (id) {
          if (account.agent_id !== id) throw new APIError(409, 'IDENTITY_MISMATCH', '必须使用同一个 Agent 账号');
          store.credentials(id, account.token, account.expires_at, account.name, account.username);
        } else {
          if (store.agent(account.agent_id)) throw new APIError(409, 'ALREADY_EXISTS', '该 Agent 已接入');
          store.add(account);
        }
        connections.restart(account.agent_id);
        return json(response, id ? 200 : 201, { agent: view(account.agent_id) });
      }
      if (id && !match?.[2] && method === 'PATCH') {
        const input = await body(request);
        if (typeof input.enabled !== 'boolean') throw new APIError(400, 'INVALID_REQUEST', 'enabled 必须是布尔值');
        store.enable(id, input.enabled); connections.restart(id);
        return json(response, 200, { agent: view(id) });
      }
      if (id && match?.[2] === 'inbox' && method === 'GET') {
        const before = Number(url.searchParams.get('before_id') ?? Number.MAX_SAFE_INTEGER);
        const limit = Number(url.searchParams.get('limit') ?? 50);
        if (!Number.isSafeInteger(before) || before < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new APIError(400, 'INVALID_REQUEST', '分页参数无效');
        }
        return json(response, 200, store.inbox(id, before, limit));
      }
      throw new APIError(404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      const known = error instanceof APIError;
      if (!known) console.error('Adaptor request failed');
      json(response, known ? error.status : 500, { error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '本机服务处理失败' } });
    }
  });
}
