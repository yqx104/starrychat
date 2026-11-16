import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ImMcp } from '../service/im-mcp.ts';
import { APIError } from '../model/errors.ts';
import { body } from './json.ts';

export async function handleMcp(request: IncomingMessage, response: ServerResponse, mcp: ImMcp) {
  let host: URL;
  try { host = new URL(`http://${request.headers.host ?? ''}`); }
  catch { throw new APIError(403, 'FORBIDDEN', '无效的 MCP Host'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) ||
      Number(host.port || 80) !== request.socket.localPort ||
      (request.headers.origin && request.headers.origin !== host.origin)) {
    throw new APIError(403, 'FORBIDDEN', 'MCP 只接受本机同源请求');
  }
  const authCount = request.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === 'authorization').length;
  const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1];
  let agentId: string;
  try { agentId = mcp.authenticate(authCount === 1 ? token ?? '' : ''); }
  catch (error) {
    response.setHeader('WWW-Authenticate', 'Bearer realm="starrychat-im"');
    throw error;
  }
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    throw new APIError(405, 'METHOD_NOT_ALLOWED', '此 MCP 入口使用无状态 HTTP POST');
  }
  const input = await body(request);
  const server = mcp.createServer(agentId);
  // A fresh transport and server per request prevent sharing identity or response state across agents.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.setHeader('Cache-Control', 'no-store');
  response.once('close', () => { void server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, input);
  } catch (error) { await server.close(); throw error; }
}
