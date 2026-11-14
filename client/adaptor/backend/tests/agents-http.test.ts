import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { Store } from '../src/repository/store.ts';
import { Agents } from '../src/service/agents.ts';
import { Connections } from '../src/service/connections.ts';
import { Sessions } from '../src/service/sessions.ts';
import { createApp } from '../src/http/server.ts';

test('agent HTTP routes preserve login, identity checks, enablement and safe responses', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'adaptor-agents-http-'));
  const path = join(directory, 'test.sqlite');
  const db = new DatabaseSync(path); db.exec(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8')); db.close();
  const store = new Store(path);
  const im = createServer(async (request, response) => {
    assert.equal(request.url, '/auth/login');
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(input.transport, 'bearer');
    if (input.password === 'wrong') { response.writeHead(401); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ participant: { participant_id: input.username, kind: 'agent', name: input.username },
      token: 'private-login-token', expires_at: Date.now() + 3600000 }));
  });
  im.listen(0, '127.0.0.1'); await once(im, 'listening');
  const imAddress = im.address(); assert(imAddress && typeof imAddress === 'object');
  const trigger = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(trigger, 'listening');
  const triggerAddress = trigger.address(); assert(typeof triggerAddress === 'object');
  let connected = 0;
  trigger.on('connection', socket => {
    connected++;
    socket.send(JSON.stringify({ type: 'ready', agent_id: 'a', token: 'private-renewed-token', expires_at: Date.now() + 3600000 }));
  });
  const config = { address: '127.0.0.1:0', adaptor_id: 'http-test', sqlite_path: path,
    im_base_url: `http://127.0.0.1:${imAddress.port}`, trigger_ws_url: `ws://127.0.0.1:${triggerAddress.port}` };
  const sessions = new Sessions(store, config);
  const connections = new Connections(store, config);
  const agents = new Agents(store, config, connections, sessions);
  const app = createApp(config, agents, sessions, () => store.checkHealth());
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const address = app.address(); assert(address && typeof address === 'object');
  t.after(async () => {
    connections.close(); await sessions.close();
    await new Promise<void>(resolve => { app.close(() => resolve()); app.closeAllConnections(); });
    await new Promise<void>(resolve => { im.close(() => resolve()); im.closeAllConnections(); });
    for (const socket of trigger.clients) socket.terminate();
    await new Promise<void>(resolve => trigger.close(() => resolve()));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const request = async (path: string, method = 'GET', body?: unknown, want = 200) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method,
      headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json() as any;
    assert.equal(response.status, want, JSON.stringify(data));
    assert(!JSON.stringify(data).includes('private-'));
    return data;
  };
  assert.deepEqual(await request('/healthz'), { status: 'ok' });
  assert.deepEqual(await request('/agents'), { agents: [] });
  await request('/agents', 'POST', { username: 'a', password: 'wrong' }, 401);
  const created = await request('/agents', 'POST', { username: 'a', password: 'fixture-password' }, 201);
  assert.equal(created.agent.agent_id, 'a'); assert.equal(created.agent.enabled, true);
  for (let i = 0; i < 120 && connections.status('a').connection_state !== 'online'; i++) await delay(25);
  assert.equal(connections.status('a').connection_state, 'online');
  assert.equal(store.agent('a')!.token, 'private-renewed-token');
  await request('/agents', 'POST', { username: 'a', password: 'fixture-password' }, 409);
  await request('/agents/a/reauthenticate', 'POST', { username: 'other', password: 'fixture-password' }, 409);
  assert.equal(store.agent('a')!.token, 'private-renewed-token');
  assert.equal(connected, 1);
  const disabled = await request('/agents/a', 'PATCH', { enabled: false });
  assert.equal(disabled.agent.enabled, false); assert.equal(disabled.agent.connection_state, 'disabled');
  await request('/agents/a/reauthenticate', 'POST', { username: 'a', password: 'fixture-password' });
  assert.equal(store.agent('a')!.token, 'private-login-token');
  assert.equal(connected, 1, 'reauthentication must not reconnect a disabled Agent');
  await request('/agents/a', 'PATCH', { enabled: true });
  for (let i = 0; i < 120 && connected < 2; i++) await delay(25);
  assert.equal(connected, 2);
  assert.equal((await request('/agents')).agents.length, 1);
  assert.deepEqual(await request('/agents/a/inbox'), { messages: [], has_more: false });
  await request('/agents/a/inbox?limit=0', 'GET', undefined, 400);
  await request('/agents/missing', 'PATCH', { enabled: false }, 404);
  await request('/missing', 'GET', undefined, 404);
});
