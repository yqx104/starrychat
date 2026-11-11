import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { Store, publicAgent, type Delivery } from '../src/store.ts';
import { Connections } from '../src/connections.ts';

async function until(condition: () => boolean) {
  for (let i = 0; i < 120; i++) { if (condition()) return; await delay(50); }
  assert.fail('Condition did not become true');
}

test('ACK follows committed SQLite write; failed writes replay; duplicate receipt survives reopening', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'adaptor-receipt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'test.sqlite');
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8')); db.close();
  let store = new Store(path);
  store.add({ agent_id: 'agent-a', name: 'Agent A', username: 'agent_a', token: 'initial-test-token', expires_at: Date.now() + 3600000 });
  store.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON inbox BEGIN SELECT RAISE(ABORT,'test disk write failure'); END");
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert(typeof address === 'object');
  const item: Delivery = { agent_id: 'agent-a', channel_id: 'channel-a', message: {
    message_id: 'message-a', channel_type: 'im_direct', conversation_id: 'conversation-a', message_seq: 1,
    sender_id: 'human', sender_kind: 'human', content: 'persist before ACK', mentioned_agent_ids: [], quoted_message_id: null, created_at: Date.now(),
  } };
  let acks = 0; let disconnected = false;
  server.on('connection', socket => {
    socket.on('message', data => {
      const frame = JSON.parse(String(data)); assert.equal(frame.type, 'ack');
      assert.equal(store.inbox('agent-a', Number.MAX_SAFE_INTEGER, 50).messages.length, 1);
      acks++;
    });
    socket.on('close', () => { disconnected = true; });
    socket.send(JSON.stringify({ type: 'ready', agent_id: 'agent-a', token: 'renewed-test-token', expires_at: Date.now() + 3600000 }));
    socket.send(JSON.stringify({ type: 'delivery', ...item }));
  });
  const config = { address: '127.0.0.1:4183', adaptor_id: 'test', im_base_url: 'http://localhost', trigger_ws_url: `ws://127.0.0.1:${address.port}`, sqlite_path: path };
  let connections = new Connections(store, config);
  t.after(() => { connections.close(); store.close(); });
  connections.startAll();
  await until(() => disconnected);
  assert.equal(acks, 0);
  assert.equal(store.inbox('agent-a', Number.MAX_SAFE_INTEGER, 50).messages.length, 0);
  store.db.exec('DROP TRIGGER fail_receipt');
  await until(() => acks === 1);
  for (const socket of server.clients) socket.send(JSON.stringify({ type: 'delivery', ...item }));
  await until(() => acks === 2);
  assert.equal(store.inbox('agent-a', Number.MAX_SAFE_INTEGER, 50).messages.length, 1);
  assert(!('token' in publicAgent(store.agent('agent-a')!)));
  connections.close(); store.close();
  store = new Store(path);
  assert.equal(store.agent('agent-a')!.token, 'renewed-test-token');
  connections = new Connections(store, config); connections.startAll();
  await until(() => acks === 3);
  assert.equal(store.inbox('agent-a', Number.MAX_SAFE_INTEGER, 50).messages.length, 1);
  assert.equal(store.inbox('agent-a', Number.MAX_SAFE_INTEGER, 50).messages[0].state, 'pending');
});
