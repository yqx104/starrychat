import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Store } from '../src/repository/store.ts';
import type { Delivery } from '../src/model/types.ts';
import { Sessions } from '../src/service/sessions.ts';
import { Dispatcher } from '../src/service/dispatch.ts';
import { Connections } from '../src/service/connections.ts';
import { Agents } from '../src/service/agents.ts';
import { createApp } from '../src/http/server.ts';

const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const cliPath = fileURLToPath(new URL('../../../pi-adaptor/tests/fixtures/rpc.mjs', import.meta.url));
async function until(condition: () => boolean, description = 'condition') {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(25); }
  assert.fail(`Timeout: ${description}`);
}
function delivery(agentId: string, id: string, channel = 'direct'): Delivery {
  return { agent_id: agentId, channel_id: channel, message: { message_id: id, channel_type: channel === 'direct' ? 'im_direct' : 'im_group',
    conversation_id: channel, message_seq: 1, sender_id: 'human', sender_kind: 'human', content: id,
    mentioned_agent_ids: [agentId], quoted_message_id: 'quoted-original', created_at: Date.now() } };
}
function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'adaptor-runtime-'));
  const path = join(directory, 'adaptor.sqlite');
  const db = new DatabaseSync(path); db.exec(schema); db.close();
  const store = new Store(path);
  const config = { address: '127.0.0.1:4183', im_base_url: 'http://127.0.0.1:9', trigger_ws_url: 'ws://127.0.0.1:9',
    adaptor_id: 'fixture', sqlite_path: path, data_root: join(directory, 'runtime'), pi_cli_path: cliPath };
  const sessions = new Sessions(store, config);
  const dispatcher = new Dispatcher(store, sessions); sessions.onReady = id => dispatcher.wake(id);
  const connections = new Connections(store, config, id => dispatcher.wake(id));
  t.after(async () => { connections.close(); dispatcher.stop(); await sessions.close(); await dispatcher.drain(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const add = (id: string, fixture = {}) => {
    const cwd = join(directory, id); mkdirSync(cwd);
    writeFileSync(join(cwd, 'fixture.json'), JSON.stringify(fixture));
    store.add({ agent_id: id, username: id, name: id, token: 'private-im-token', expires_at: Date.now() + 3600000 });
    store.configure(id, cwd, { pi_config_dir: join(cwd, 'pi') });
    return cwd;
  };
  const inputs = (id: string) => store.inbox(id, Number.MAX_SAFE_INTEGER, 100).messages;
  const commands = (id: string) => readFileSync(join(directory, id, 'commands.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const prompts = (id: string) => commands(id).filter(command => command.type === 'prompt');
  return { directory, store, sessions, dispatcher, connections, config, add, inputs, commands, prompts };
}

test('sessions dispatch concurrently, preserve per-session order/provenance and deduplicate wakeups', async t => {
  const f = setup(t); f.add('a', { receiptDelayMs: 350 }); f.add('b');
  const first = delivery('a', 'a-one'); f.store.receive(first); f.store.receive(delivery('a', 'a-two', 'group')); f.store.receive(delivery('b', 'b-one'));
  f.sessions.startAll(); f.dispatcher.start();
  await until(() => f.inputs('b')[0].state === 'accepted');
  assert.equal(f.inputs('a')[1].state, 'sending', 'B must not wait for A receipt');
  assert.equal(f.sessions.view('a').blocked, null, 'waiting for a receipt is not a recovery pause');
  for (let i = 0; i < 30; i++) f.dispatcher.wake('a');
  assert.equal(f.store.receive(first), false); f.dispatcher.wake('a');
  await until(() => f.inputs('a').every(input => input.state === 'accepted'));
  const prompts = f.prompts('a'); assert.equal(prompts.length, 2);
  assert.deepEqual(prompts.map(command => JSON.parse(command.message.split('\n')[1]).message.content), ['a-one', 'a-two']);
  const source = JSON.parse(prompts[1].message.split('\n')[1]);
  assert.equal(source.channel_id, 'group'); assert.equal(source.message.sender_id, 'human'); assert.equal(source.message.quoted_message_id, 'quoted-original');
  assert.equal(f.inputs('a')[0].receipt_disposition, 'queued');
  assert.notEqual(prompts[0].pid, f.prompts('b')[0].pid);
  assert.notEqual(f.store.session('a')!.session_id, f.store.session('b')!.session_id);
});

test('disable stops dispatch; late replies cannot overwrite recovery; re-enable restores the same session', async t => {
  const f = setup(t); f.add('a', { receiptDelayMs: 600 });
  f.store.receive(delivery('a', 'one')); f.store.receive(delivery('a', 'two'));
  f.sessions.startAll(); f.dispatcher.start();
  await until(() => f.inputs('a')[1].state === 'sending');
  // Wait until the subprocess actually persisted the input, but before its delayed response.
  await until(() => f.sessions.view('a').session?.native_ref?.session_file != null);
  const original = f.store.session('a')!;
  f.store.enable('a', false); await f.sessions.reconcile('a');
  assert.equal(f.inputs('a')[1].state, 'accepted', 'persisted input can be reconciled without replay');
  assert.equal(f.inputs('a')[0].state, 'pending'); assert.equal(f.prompts('a').length, 1);
  assert.equal(f.sessions.view('a').status, 'disabled');
  f.store.enable('a', true); await f.sessions.reconcile('a');
  await until(() => f.inputs('a')[0].state === 'accepted');
  assert.equal(f.store.session('a')!.session_id, original.session_id);
  assert.equal(JSON.parse(f.store.session('a')!.native_ref_json!).session_id, JSON.parse(original.native_ref_json!).session_id);
  assert.equal(f.prompts('a').length, 2);
});

test('uncertain input blocks only its session and survives backend restart until explicitly resolved', async t => {
  const f = setup(t); f.add('a'); f.add('b');
  f.store.receive(delivery('a', 'CRASH')); f.store.receive(delivery('a', 'later')); f.store.receive(delivery('b', 'healthy'));
  f.sessions.startAll(); f.dispatcher.start();
  await until(() => f.sessions.view('a').status === 'error' && f.inputs('a')[1].state === 'needs_recovery');
  await until(() => f.inputs('b')[0].state === 'accepted');
  assert.equal(f.inputs('a')[0].state, 'pending'); assert.equal(f.prompts('a').length, 1);
  f.dispatcher.stop(); await f.sessions.close(); await f.dispatcher.drain();
  const restarted = new Sessions(f.store, f.config); const dispatch = new Dispatcher(f.store, restarted);
  restarted.onReady = id => dispatch.wake(id);
  restarted.startAll(); dispatch.start();
  await until(() => restarted.view('a').status === 'error');
  assert.equal(f.inputs('a')[1].state, 'needs_recovery'); assert.equal(f.prompts('a').length, 1);
  f.store.enable('a', false); await restarted.reconcile('a');
  assert(f.store.resolveInput('a', Number(f.inputs('a')[1].id), 'retry'));
  // A user repairs the source of failure before retrying. A retry is never performed automatically.
  f.store.db.prepare('UPDATE inbox SET message_json=? WHERE id=?').run(JSON.stringify(delivery('a', 'repaired').message), f.inputs('a')[1].id);
  f.store.enable('a', true); await restarted.reconcile('a');
  await until(() => f.inputs('a').every(input => input.state === 'accepted'));
  dispatch.stop(); await restarted.close(); await dispatch.drain();
});

test('queued input absent from history becomes needs_recovery; a settled input remains accepted', async t => {
  const f = setup(t); f.add('a');
  f.store.receive(delivery('a', 'first')); f.store.receive(delivery('a', 'queued'));
  await f.sessions.reconcile('a'); f.dispatcher.start();
  await until(() => f.inputs('a').every(input => input.state === 'accepted'));
  f.store.enable('a', false); await f.sessions.reconcile('a');
  assert.equal(f.inputs('a')[0].state, 'needs_recovery');
  assert.equal(f.inputs('a')[0].receipt_disposition, 'queued');
  assert.equal(f.inputs('a')[1].state, 'accepted');
  f.store.enable('a', true); await f.sessions.reconcile('a'); await delay(75);
  assert.equal(f.prompts('a').length, 2); assert.equal(f.sessions.view('a').blocked, 'needs_recovery');
});

test('transient rejection backs off at the head; explicit rejection pauses without changing enabled', async t => {
  const f = setup(t); f.add('a');
  f.store.receive(delivery('a', 'TRANSIENT')); f.store.receive(delivery('a', 'REJECT')); f.store.receive(delivery('a', 'last'));
  await f.sessions.reconcile('a'); f.dispatcher.start();
  await until(() => !!f.inputs('a')[2].last_error);
  f.dispatcher.wake('a'); await delay(100); assert.equal(f.prompts('a').length, 1);
  await until(() => f.inputs('a')[1].state === 'rejected');
  assert.equal(f.inputs('a')[2].state, 'accepted'); assert.equal(f.inputs('a')[0].state, 'pending');
  assert.equal(f.prompts('a').length, 3); assert.equal(f.store.agent('a')!.enabled, 1);
});

test('handled input without model history does not prevent reopening the same empty session', async t => {
  const f = setup(t); f.add('a'); f.store.receive(delivery('a', 'HANDLED'));
  await f.sessions.reconcile('a'); f.dispatcher.start();
  await until(() => f.inputs('a')[0].state === 'accepted');
  assert.equal(f.inputs('a')[0].receipt_disposition, 'handled');
  const nativeId = JSON.parse(f.store.session('a')!.native_ref_json!).session_id;
  f.store.enable('a', false); await f.sessions.reconcile('a');
  f.store.enable('a', true); await f.sessions.reconcile('a');
  assert.equal(f.sessions.view('a').status, 'idle');
  assert.equal(JSON.parse(f.store.session('a')!.native_ref_json!).session_id, nativeId);
  assert.equal(f.prompts('a').length, 1);
});

test('periodic scan recovers a lost receipt wakeup; new arrivals are read after the active receipt', async t => {
  const f = setup(t); f.add('a', { receiptDelayMs: 100 });
  await f.sessions.reconcile('a'); f.dispatcher.start();
  f.store.receive(delivery('a', 'missed-wakeup'));
  await until(() => f.inputs('a')[0].state === 'sending');
  f.store.receive(delivery('a', 'arrived-during-receipt')); f.dispatcher.wake('a');
  await until(() => f.inputs('a').every(input => input.state === 'accepted'));
  assert.equal(f.prompts('a').length, 2);
});

test('runtime HTTP API enforces config lifecycle, exposes safe events and validates manual recovery', async t => {
  const f = setup(t); f.add('a');
  const server = createApp(f.config, new Agents(f.store, f.config, f.connections, f.sessions), f.sessions, () => f.store.checkHealth()); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address === 'object');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const request = async (path: string, method = 'GET', body?: unknown, want = 200) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method,
      headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json() as any; assert.equal(response.status, want, JSON.stringify(data)); return data;
  };
  await f.sessions.reconcile('a');
  const runtime = (await request('/agents/a/runtime')).runtime;
  await request('/agents/a/runtime', 'PATCH', runtime, 409);
  await request('/agents/a/runtime', 'PATCH', { ...runtime, config: { api_key: 'should-not-be-stored' } }, 400);
  f.store.receive(delivery('a', 'show-output')); f.dispatcher.start();
  await until(() => f.inputs('a')[0].state === 'accepted');
  const sessionId = f.store.session('a')!.session_id;
  const events = await request(`/sessions/${sessionId}/events`);
  assert(events.events.some((event: any) => event.type === 'text'));
  assert(!JSON.stringify(events).includes('must-not-be-exposed'));
  assert(!JSON.stringify(await request('/agents')).includes('private-im-token'));
  await request(`/sessions/${sessionId}/abort`, 'POST', {});
  assert.equal(f.store.agent('a')!.enabled, 1);
  await request('/agents/a', 'PATCH', { enabled: false });
  await request('/agents/a/runtime', 'PATCH', runtime);
  const id = Number(f.inputs('a')[0].id);
  f.store.db.prepare("UPDATE inbox SET state='needs_recovery' WHERE id=?").run(id);
  await request(`/sessions/${sessionId}/inputs/${id}/resolve`, 'POST', { action: 'retry' }, 400);
  await request(`/sessions/${sessionId}/inputs/${id}/resolve`, 'POST', { action: ['retry'], confirmed: true }, 400);
  await request(`/sessions/${sessionId}/inputs/${id}/resolve`, 'POST', { action: 'accepted', confirmed: true });
  assert.equal(f.inputs('a')[0].state, 'accepted');
  assert.equal((await request(`/sessions/${sessionId}/events?after=99999&epoch=old-process`)).events.length, f.sessions.readEvents(sessionId, 0).events.length);
  const crossOrigin = await fetch(`http://127.0.0.1:${address.port}/agents`, { headers: { Origin: 'http://other.example' } });
  assert.equal(crossOrigin.status, 403);
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
});

test('startup rejects an outdated schema without changing the database or creating backups', t => {
  const directory = mkdtempSync(join(tmpdir(), 'adaptor-schema-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'legacy.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE agents (agent_id TEXT PRIMARY KEY,name TEXT NOT NULL,username TEXT NOT NULL,token TEXT NOT NULL,
    credential_expires_at INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE inbox (id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id TEXT NOT NULL REFERENCES agents(agent_id),message_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,message_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',received_at INTEGER NOT NULL,UNIQUE(agent_id,message_id));
    CREATE INDEX inbox_agent_id ON inbox(agent_id,id);
    INSERT INTO agents VALUES ('a','a','a','keep-private',9999999999999,1,1,1);`);
  const item = delivery('a', 'original');
  db.prepare('INSERT INTO inbox (id,agent_id,message_id,channel_id,message_json,received_at) VALUES (42,?,?,?,?,1)')
    .run('a', 'original', item.channel_id, JSON.stringify(item.message)); db.close();
  const before = readFileSync(path);
  assert.throws(() => new Store(path), /SQLite 结构与当前 schema.sql 不一致.*AGENTS\.md/);
  assert.deepEqual(readFileSync(path), before, 'startup must preserve the existing schema and data');
  assert.deepEqual(readdirSync(directory), ['legacy.sqlite']);
});
