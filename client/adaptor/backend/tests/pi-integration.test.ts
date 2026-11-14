import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { Store } from '../src/repository/store.ts';
import { Sessions } from '../src/service/sessions.ts';
import { Dispatcher } from '../src/service/dispatch.ts';
import { Connections } from '../src/service/connections.ts';

async function until(condition: () => boolean, description: string) {
  for (let i = 0; i < 400; i++) { if (condition()) return; await delay(25); }
  assert.fail(`Timeout: ${description}`);
}

test('WS → SQLite ACK → Dispatcher → real Pi RPC → local model/tool → events; restart retains history', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'adaptor-real-pi-'));
  const piConfig = join(directory, 'pi'); mkdirSync(piConfig);
  const requests: any[] = [];
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>(resolve => { releaseFirst = resolve; });
  const model = createServer(async (request, response) => {
    const buffers = []; for await (const chunk of request) buffers.push(chunk);
    const body = JSON.parse(Buffer.concat(buffers).toString()); requests.push(body);
    assert.equal(request.url, '/v1/chat/completions');
    if (requests.length === 1) await firstRelease;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = requests.length === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_local_write', type: 'function',
      function: { name: 'write', arguments: JSON.stringify({ path: join(directory, 'proof.txt'), content: 'MVP tool executed' }) } }] } :
      { role: 'assistant', content: 'MVP verified' };
    for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }]) {
      response.write(`data: ${JSON.stringify({ id: 'local-completion', object: 'chat.completion.chunk', created: 1, model: 'local-model', choices: [choice] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const modelAddress = model.address(); assert(modelAddress && typeof modelAddress === 'object');
  writeFileSync(join(piConfig, 'models.json'), JSON.stringify({ providers: { 'local-mvp-test': {
    baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`, api: 'openai-completions', apiKey: 'local-test-key',
    models: [{ id: 'local-model', name: 'Local test model', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }), { mode: 0o600 });
  writeFileSync(join(piConfig, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  const trigger = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(trigger, 'listening');
  const triggerAddress = trigger.address(); assert(typeof triggerAddress === 'object');
  const path = join(directory, 'adaptor.sqlite'); const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8')); db.close();
  const store = new Store(path);
  const config = { address: '127.0.0.1:4183', im_base_url: 'http://127.0.0.1:9', trigger_ws_url: `ws://127.0.0.1:${triggerAddress.port}`,
    adaptor_id: 'real-pi-test', sqlite_path: path, data_root: join(directory, 'runtime'),
    pi_cli_path: fileURLToPath(new URL('../../../../agents/pi/upstream/packages/coding-agent/dist/bundle/rpc-entry.js', import.meta.url)) };
  store.add({ agent_id: 'a', name: 'a', username: 'a', token: 'private-im-test-token', expires_at: Date.now() + 3600000 });
  store.configure('a', directory, { pi_config_dir: piConfig, provider: 'local-mvp-test', model: 'local-model' });
  let sessions = new Sessions(store, config); let dispatcher = new Dispatcher(store, sessions);
  sessions.onReady = id => dispatcher.wake(id);
  const connections = new Connections(store, config, id => dispatcher.wake(id));
  t.after(async () => {
    releaseFirst(); connections.close(); dispatcher.stop(); await sessions.close(); await dispatcher.drain();
    for (const client of trigger.clients) client.terminate();
    await new Promise<void>(resolve => trigger.close(() => resolve()));
    await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections(); });
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  let acks = 0;
  trigger.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'ready', agent_id: 'a', token: 'private-im-test-token', expires_at: Date.now() + 3600000 }));
    socket.on('message', data => {
      assert.equal(JSON.parse(String(data)).type, 'ack');
      // ACK is observed before the blocked local model finishes.
      assert(store.inbox('a', Number.MAX_SAFE_INTEGER, 50).messages.length > 0); acks++;
    });
  });
  const send = (id: string, content: string) => {
    const frame = { type: 'delivery', agent_id: 'a', channel_id: id === 'one' ? 'direct' : 'group', message: {
      message_id: id, channel_type: id === 'one' ? 'im_direct' : 'im_group', conversation_id: id,
      sender_id: 'human', sender_kind: 'human', message_seq: 1, content, mentioned_agent_ids: ['a'], quoted_message_id: null, created_at: Date.now(),
    } };
    for (const socket of trigger.clients) socket.send(JSON.stringify(frame));
  };
  const inbox = () => store.inbox('a', Number.MAX_SAFE_INTEGER, 50).messages;
  connections.startAll(); sessions.startAll(); dispatcher.start();
  await until(() => connections.status('a').connection_state === 'online', 'Trigger online');
  await until(() => !!sessions.current('a') || sessions.view('a').status === 'error', 'Pi startup');
  assert.notEqual(sessions.view('a').status, 'error', sessions.view('a').last_error ?? 'Pi startup');
  send('one', 'Write the local proof file.');
  await until(() => requests.length === 1, 'local model request');
  send('two', 'Include this group input.');
  await until(() => acks === 2 && inbox().every(input => input.state === 'accepted'), 'queued input and ACKs');
  assert.equal(inbox()[0].receipt_disposition, 'queued');
  for (const socket of trigger.clients) socket.terminate();
  await until(() => connections.status('a').connection_state === 'reconnecting', 'Trigger disconnect');
  assert.equal(store.agent('a')!.enabled, 1); assert(sessions.current('a'));
  releaseFirst();
  await until(() => existsSync(join(directory, 'proof.txt')) && sessions.view('a').status === 'idle', 'tool and settled event');
  assert.equal(readFileSync(join(directory, 'proof.txt'), 'utf8'), 'MVP tool executed');
  assert(requests.some(body => JSON.stringify(body.messages).includes('Include this group input.')));
  const original = sessions.view('a').session!;
  const events = sessions.readEvents(original.session_id, 0).events;
  assert(events.some(event => event.type === 'tool' && event.tool === 'write'));
  assert(events.some(event => event.type === 'text' && event.text?.includes('MVP verified')));
  assert(!JSON.stringify({ events, view: sessions.view('a') }).includes('local-test-key'));
  dispatcher.stop(); await sessions.close(); await dispatcher.drain();
  assert(inbox().every(input => input.state === 'accepted'));
  sessions = new Sessions(store, config); dispatcher = new Dispatcher(store, sessions); sessions.onReady = id => dispatcher.wake(id);
  await sessions.reconcile('a'); dispatcher.start();
  assert.equal(sessions.view('a').session!.native_ref!.session_id, original.native_ref!.session_id);
  const count = requests.length; await delay(100); assert.equal(requests.length, count, 'old inputs must not replay');
  await until(() => connections.status('a').connection_state === 'online', 'Trigger reconnect');
  send('three', 'Confirm the earlier proof.');
  await until(() => requests.length > count && sessions.view('a').status === 'idle', 'restored turn');
  assert(JSON.stringify(requests.at(-1).messages).includes('Write the local proof file.'));
  assert(JSON.stringify(requests.at(-1).messages).includes('MVP verified'));
});
