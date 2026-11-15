import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Store } from '../src/repository/store.ts';
import { Sessions } from '../src/service/sessions.ts';
import { Dispatcher } from '../src/service/dispatch.ts';
import { prepareAgentDirectories } from '../src/service/directories.ts';
import { createApp } from '../src/http/server.ts';
import { Agents } from '../src/service/agents.ts';
import { Connections } from '../src/service/connections.ts';

async function until(condition: () => boolean, description: string) {
  for (let i = 0; i < 300; i++) { if (condition()) return; await delay(25); }
  assert.fail(description);
}

test('private Pi configuration gates dispatch, ignores host keys and isolates two real RPC instances', { timeout: 30000 }, async t => {
  const oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'host-key-must-never-be-used';
  t.after(() => { if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey; });
  const directory = mkdtempSync(join(tmpdir(), 'adaptor-private-config-'));
  const path = join(directory, 'db.sqlite');
  const db = new DatabaseSync(path); db.exec(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8')); db.close();
  const store = new Store(path);
  const config = { address: '127.0.0.1:4183', im_base_url: 'http://127.0.0.1:9', trigger_ws_url: 'ws://127.0.0.1:9',
    adaptor_id: 'test', sqlite_path: path, agent_root: join(directory, 'agents'),
    pi_cli_path: fileURLToPath(new URL('../../../../agents/pi/upstream/packages/coding-agent/dist/bundle/rpc-entry.js', import.meta.url)) };
  const requests: Array<{ key: string | undefined; body: any }> = [];
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ key: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: {"id":"test","object":"chat.completion.chunk","model":"local-model","choices":[{"index":0,"delta":{"role":"assistant","content":"private instance verified"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const address = model.address(); assert(address && typeof address === 'object');
  let sessions = new Sessions(store, config); let dispatcher = new Dispatcher(store, sessions);
  sessions.onReady = id => dispatcher.wake(id); dispatcher.start();
  const connections = new Connections(store, config);
  const http = createApp(config, new Agents(store, config, connections, sessions), sessions, () => store.ping());
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const httpAddress = http.address(); assert(httpAddress && typeof httpAddress === 'object');
  const runtimeRequest = async (id: string, input?: object, status = 200) => {
    const response = await fetch(`http://127.0.0.1:${httpAddress.port}/agents/${id}/runtime`, input ? {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ harness: 'pi', config: input }),
    } : undefined);
    const text = await response.text(); assert.equal(response.status, status, text);
    assert(!text.includes('agent-a-') && !text.includes('agent-b-'), 'HTTP must not echo keys');
    return JSON.parse(text);
  };
  t.after(async () => {
    connections.close();
    await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
    dispatcher.stop(); await sessions.close(); await dispatcher.drain(); store.close();
    await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections(); });
    rmSync(directory, { recursive: true, force: true });
  });
  for (const id of ['a', 'b']) {
    store.add({ agent_id: id, name: id, username: id, token: 'private-im-token', expires_at: Date.now() + 3600000 });
    prepareAgentDirectories(config, id);
  }
  await sessions.configure('a', { harness: 'pi', config: {} });
  await until(() => sessions.view('a').status === 'unconfigured', 'empty config must be unconfigured');
  assert.equal(sessions.current('a'), undefined);
  const original = store.session('a')!;
  store.receive({ agent_id: 'a', channel_id: 'direct', message: { message_id: 'one', channel_type: 'im_direct',
    conversation_id: 'one', sender_id: 'human', sender_kind: 'human', message_seq: 1, content: 'agent-a-input',
    mentioned_agent_ids: ['a'], quoted_message_id: null, created_at: Date.now() } });
  dispatcher.wake('a'); await delay(50);
  assert.equal(store.nextInput('a')!.state, 'pending'); assert.equal(requests.length, 0);
  await sessions.configure('a', { harness: 'pi', config: { provider: 'deepseek', model: 'deepseek-v4-pro' } });
  await until(() => sessions.view('a').status === 'unconfigured', 'host DeepSeek credentials must not make the model available');
  assert.equal(sessions.view('a').model, null); assert.equal(sessions.current('a'), undefined);
  const aDir = join(config.agent_root, 'a', 'pi-config');
  writeFileSync(join(aDir, 'auth.json'), '{invalid');
  await runtimeRequest('a', { provider: 'deepseek', model: 'deepseek-v4-pro' }, 400);
  assert.match((await runtimeRequest('a')).configuration_issue, /auth.json/);
  assert.equal(readFileSync(join(aDir, 'auth.json'), 'utf8'), '{invalid');
  writeFileSync(join(aDir, 'auth.json'), '{}');
  await sessions.configure('a', { harness: 'pi', config: { provider: 'missing-provider', model: 'missing-model' } });
  assert.equal(sessions.view('a').status, 'unconfigured', 'an unknown model must remain editable without a fallback');
  assert.equal(requests.length, 0);
  for (const id of ['a', 'b']) {
    const dirs = prepareAgentDirectories(config, id);
    writeFileSync(join(dirs.pi_config_dir, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
    mkdirSync(join(dirs.cwd, '.pi'));
    writeFileSync(join(dirs.cwd, '.pi', 'settings.json'), JSON.stringify({ defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-pro' }));
    await runtimeRequest(id, { provider: 'local-only', model: 'local-model', base_url: `http://127.0.0.1:${address.port}/v1`,
      api: 'openai-completions', api_key: id === 'a' ? 'agent-a-$KEY' : 'agent-b-key' });
  }
  await until(() => !!sessions.current('a') && !!sessions.current('b'), 'both independently configured Pi instances must start');
  store.receive({ agent_id: 'b', channel_id: 'direct', message: { message_id: 'two', channel_type: 'im_direct',
    conversation_id: 'two', sender_id: 'human', sender_kind: 'human', message_seq: 1, content: 'agent-b-input',
    mentioned_agent_ids: ['b'], quoted_message_id: null, created_at: Date.now() } });
  dispatcher.wake('b');
  await until(() => requests.length === 2 && sessions.view('a').status === 'idle' && sessions.view('b').status === 'idle', 'both model calls must settle');
  assert.deepEqual(requests.map(r => r.key).sort(), ['Bearer agent-a-$KEY', 'Bearer agent-b-key']);
  for (const id of ['a', 'b']) {
    const record = store.session(id)!; const saved = JSON.parse(record.config_json);
    assert.equal(saved.provider, undefined); assert.equal(saved.model, undefined);
    const settings = JSON.parse(readFileSync(join(saved.pi_config_dir, 'settings.json'), 'utf8'));
    assert.equal(settings.defaultProvider, 'local-only'); assert.deepEqual(settings.retry, { enabled: false });
    assert(!JSON.stringify(sessions.runtimeConfig(id)).includes(`agent-${id}-key`));
    assert(existsSync(JSON.parse(record.native_ref_json!).session_file));
  }
  assert.equal(store.session('a')!.session_id, original.session_id);
  await runtimeRequest('a', { provider: 'local-only', model: 'local-model', api_key: 'replacement' }, 409);
  store.enable('a', false); await sessions.reconcile('a');
  await runtimeRequest('a', { provider: 'local-only', model: 'local-model', api_key: '' });
  assert.equal(JSON.parse(readFileSync(join(aDir, 'auth.json'), 'utf8'))['local-only'].key, 'agent-a-$$KEY');
  await runtimeRequest('a', { provider: 'local-only', model: 'local-model', clear_api_key: true });
  store.enable('a', true); await sessions.reconcile('a');
  assert.equal(sessions.view('a').status, 'unconfigured');
  assert.equal((await runtimeRequest('a')).model_options.find((p: any) => p.id === 'local-only').has_api_key, false);
  assert.equal(sessions.view('b').status, 'idle');
  dispatcher.stop(); await sessions.close(); await dispatcher.drain();
  // Remove only A's selection: its history and B's valid configuration cannot supply a fallback model.
  writeFileSync(join(aDir, 'settings.json'), '{}');
  sessions = new Sessions(store, config); dispatcher = new Dispatcher(store, sessions);
  sessions.onReady = id => dispatcher.wake(id); sessions.startAll(); dispatcher.start();
  await until(() => sessions.view('a').status === 'unconfigured' && sessions.view('b').status === 'idle', 'restart must preserve independent configuration states');
  assert.equal(sessions.view('a').model, null); assert.equal(requests.length, 2, 'history must not replay');
});
