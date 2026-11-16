import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/repository/store.ts';
import { ImMcp } from '../src/service/im-mcp.ts';
import { Sessions } from '../src/service/sessions.ts';
import { Connections } from '../src/service/connections.ts';
import { Agents } from '../src/service/agents.ts';
import { createApp } from '../src/http/server.ts';

const a = '01900000-0000-7000-8000-000000000001';
const b = '01900000-0000-7000-8000-000000000002';
const human = '01900000-0000-7000-8000-000000000003';
const conversationId = '01900000-0000-7000-8000-000000000004';
const messageId = '01900000-0000-7000-8000-000000000005';
const forbidden = '01900000-0000-7000-8000-000000000006';
const participants = [a, b, human].map(id => ({ participant_id: id, kind: id === human ? 'human' : 'agent', name: id, created_at: 1 }));
const conversation = { conversation_id: conversationId, kind: 'group', title: 'Shared chat', created_at: 1, dissolved_at: null, hidden: false };
const message = { message_id: messageId, conversation_id: conversationId, message_seq: 1, sender_id: human,
  content: 'context without an @', mentioned_agent_ids: [], quoted_message_id: null, created_at: 1 };

test('standard HTTP MCP tools bind identities, renew IM auth, paginate full history and never retry ambiguous sends', async t => {
  const root = mkdtempSync(join(tmpdir(), 'adaptor-mcp-'));
  const dbPath = join(root, 'adaptor.sqlite'); const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8')); db.close();
  const store = new Store(dbPath);
  const calls: Array<{ path: string; actor: string; body: any }> = [];
  let sends = 0; let renewal = 0;
  const im = createServer(async (request, response) => {
    const actor = request.headers.authorization?.startsWith('Bearer im-a-') ? a : b;
    assert(request.headers.authorization?.startsWith(actor === a ? 'Bearer im-a-' : 'Bearer im-b-'));
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const url = new URL(request.url!, 'http://localhost');
    calls.push({ path: request.url!, actor, body: input });
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('X-IM-Token', `im-${actor === a ? 'a' : 'b'}-renewed-${++renewal}`);
    response.setHeader('X-IM-Token-Expires-At', Date.now() + 7 * 86400000);
    const reply = (data: unknown) => response.end(JSON.stringify(data));
    if (url.pathname.includes(forbidden)) { response.statusCode = 403; reply({ error: { code: 'FORBIDDEN', message: 'Not a member' } }); return; }
    if (url.pathname === '/auth/me') {
      await delay(actor === a ? 30 : 5);
      reply({ participant: participants.find(p => p.participant_id === actor), token: 'must-not-leak' });
    } else if (url.pathname === '/participants') {
      reply({ participants: participants.filter(p => !url.searchParams.has('kind') || p.kind === url.searchParams.get('kind')) });
    } else if (url.pathname === '/conversations') reply({ conversations: [conversation] });
    else if (url.pathname === `/conversations/${conversationId}`) reply({ conversation });
    else if (url.pathname.endsWith('/members')) reply({ members: participants });
    else if (url.pathname.endsWith('/messages') && request.method === 'GET') reply({ messages: [message], has_more: true });
    else if (url.pathname.endsWith('/messages') && request.method === 'POST') {
      sends++;
      if (input.content === 'drop-after-save') { response.destroy(); return; }
      response.statusCode = 201;
      reply({ message: { ...message, sender_id: actor, ...input, message_seq: 2 } });
    } else { response.statusCode = 404; reply({}); }
  });
  im.listen(0, '127.0.0.1'); await once(im, 'listening');
  const imAddress = im.address(); assert(imAddress && typeof imAddress === 'object');
  const config = { address: '127.0.0.1:0', adaptor_id: 'mcp-test', sqlite_path: dbPath, agent_root: join(root, 'agents'),
    im_base_url: `http://127.0.0.1:${imAddress.port}`, trigger_ws_url: 'ws://127.0.0.1:9' };
  for (const [id, label] of [[a, 'a'], [b, 'b']]) store.add({ agent_id: id, name: label, username: label, token: `im-${label}-initial`, expires_at: Date.now() + 3600000 });
  const mcp = new ImMcp(store, config);
  const sessions = new Sessions(store, config); const connections = new Connections(store, config);
  const agents = new Agents(store, config, connections, sessions);
  const app = createApp(config, agents, sessions, () => store.checkHealth(), mcp);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    connections.close(); await sessions.close();
    await new Promise<void>(resolve => { app.close(() => resolve()); app.closeAllConnections(); });
    await new Promise<void>(resolve => { im.close(() => resolve()); im.closeAllConnections(); });
    store.close(); rmSync(root, { recursive: true, force: true });
  });
  const connection = mcp.connection(a); const otherConnection = mcp.connection(b);
  assert.notEqual(connection.headers.Authorization, otherConnection.headers.Authorization);
  assert(!connection.headers.Authorization.includes('im-a-initial'));
  assert.equal(statSync(`${dbPath}.mcp-credentials.json`).mode & 0o777, 0o600);
  assert.equal(new ImMcp(store, config).connection(a).headers.Authorization, connection.headers.Authorization, 'restart retains local credential');
  const clientFor = async (info: ReturnType<ImMcp['connection']>) => {
    const client = new Client({ name: 'integration-test', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(info.url), { requestInit: { headers: info.headers } }));
    return client;
  };
  const first = await clientFor(connection); const second = await clientFor(otherConnection);
  assert.match(first.getInstructions()!, /不要自动重发/);
  assert.deepEqual((await first.listTools()).tools.map(tool => tool.name).sort(), [
    'im_whoami', 'im_list_conversations', 'im_get_conversation', 'im_list_participants', 'im_list_messages', 'im_send_message',
  ].sort());
  const tool = async (client: Client, name: string, args = {}): Promise<any> => client.callTool({ name, arguments: args });
  const [self, other] = await Promise.all([tool(first, 'im_whoami'), tool(second, 'im_whoami')]);
  assert.equal(self.structuredContent.participant.participant_id, a);
  assert.equal(other.structuredContent.participant.participant_id, b);
  assert(!JSON.stringify(self).includes('must-not-leak'));
  assert.match(store.agent(a)!.token, /^im-a-renewed-/);
  assert.equal((await tool(first, 'im_list_conversations')).structuredContent.conversations[0].conversation_id, conversationId);
  assert.deepEqual((await tool(first, 'im_get_conversation', { conversation_id: conversationId })).structuredContent, { conversation, members: participants });
  assert.equal((await tool(first, 'im_list_participants', { kind: 'agent' })).structuredContent.participants.length, 2);
  const page = await tool(first, 'im_list_messages', { conversation_id: conversationId });
  assert.deepEqual(page.structuredContent, { messages: [message], has_more: true });
  assert(calls.at(-1)!.path.endsWith('?limit=20'));
  assert.equal(store.inbox(a, Number.MAX_SAFE_INTEGER, 50).messages.length, 0, 'history does not come from inbox');
  await tool(first, 'im_list_messages', { conversation_id: conversationId, after_seq: 0, limit: 5 });
  assert.match(calls.at(-1)!.path, /after_seq=0/);
  await tool(first, 'im_list_messages', { conversation_id: conversationId, before_seq: 9 });
  assert.match(calls.at(-1)!.path, /before_seq=9/);
  for (const args of [{ limit: 51 }, { before_seq: 9, after_seq: 0 }, { agent_id: b }, { conversation_id: '../agents' }]) {
    const before = calls.length;
    assert.equal((await tool(first, 'im_list_messages', { conversation_id: conversationId, ...args })).isError, true);
    assert.equal(calls.length, before);
  }
  const denied = await tool(first, 'im_list_messages', { conversation_id: forbidden });
  assert.equal(denied.isError, true); assert.equal(denied.structuredContent.error.code, 'FORBIDDEN');
  const input = { conversation_id: conversationId, content: 'reply', mentioned_agent_ids: [b], quoted_message_id: messageId };
  const sent = await tool(first, 'im_send_message', input);
  assert.equal(sent.structuredContent.message.sender_id, a);
  assert.deepEqual(calls.at(-1)!.body, { content: 'reply', mentioned_agent_ids: [b], quoted_message_id: messageId });
  assert.equal((await tool(first, 'im_send_message', { ...input, sender_id: b })).isError, true);
  assert.equal(sends, 1);
  const uncertain = await tool(first, 'im_send_message', { ...input, content: 'drop-after-save' });
  assert.equal(uncertain.isError, true); assert.equal(uncertain.structuredContent.error.code, 'SEND_RESULT_UNKNOWN');
  assert.equal(sends, 2, 'no retry after the remote server saved a message and disconnected');
  store.enable(a, false);
  assert.equal((await tool(first, 'im_whoami')).structuredContent.participant.participant_id, a, 'MCP is independent of Pi enablement');
  const lastToken = store.agent(a)!.token;
  store.credentials(a, 'im-a-reauthenticated', Date.now() + 86400000);
  store.renewCredentials(a, lastToken, 'im-a-stale-response', Date.now() + 8 * 86400000);
  assert.equal(store.agent(a)!.token, 'im-a-reauthenticated');
  await tool(first, 'im_whoami');
  store.credentials(a, 'im-a-expired', Date.now() - 1000);
  assert.equal((await tool(first, 'im_whoami')).structuredContent.error.code, 'IM_AUTH_REQUIRED');
  assert.equal((await tool(second, 'im_whoami')).structuredContent.participant.participant_id, b);
  for (const headers of [{}, { Authorization: 'Bearer im-a-initial' }, { Authorization: `Bearer ${'0'.repeat(64)}` }]) {
    const response = await fetch(connection.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
    assert.equal(response.status, 401); await response.body?.cancel();
  }
  const wrongHost = await new Promise<number>(resolve => {
    const request = httpRequest(connection.url, { method: 'POST', headers: { ...connection.headers, Host: 'evil.example', 'Content-Type': 'application/json' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode!));
    });
    request.end('{}');
  });
  assert.equal(wrongHost, 403);
  const crossOrigin = await fetch(connection.url, { method: 'POST', headers: { ...connection.headers, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(crossOrigin.status, 403); await crossOrigin.body?.cancel();
});
