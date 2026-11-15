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
  t.after(async () => {
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
  await sessions.configure('a', { harness: 'pi', config: { provider: 'deepseek', model: 'deepseek-v4-pro' } });
  await until(() => sessions.view('a').status === 'unconfigured', 'invalid auth config must be editable');
  assert.match(sessions.view('a').last_error!, /auth.json/);
  writeFileSync(join(aDir, 'auth.json'), '{}');
  await sessions.configure('a', { harness: 'pi', config: { provider: 'missing-provider', model: 'missing-model' } });
  assert.equal(sessions.view('a').status, 'unconfigured', 'an unknown model must remain editable without a fallback');
  assert.equal(requests.length, 0);
  for (const id of ['a', 'b']) {
    const dirs = prepareAgentDirectories(config, id);
    const provider = { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions',
      ...(id === 'a' ? { apiKey: 'agent-a-key' } : {}),
      models: [{ id: 'local-model', contextWindow: 128000, maxTokens: 512 }] };
    writeFileSync(join(dirs.pi_config_dir, 'models.json'), JSON.stringify({ providers: { 'local-only': provider } }));
    if (id === 'b') writeFileSync(join(dirs.pi_config_dir, 'auth.json'), JSON.stringify({ 'local-only': { type: 'api_key', key: 'agent-b-key' } }));
    writeFileSync(join(dirs.pi_config_dir, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
    mkdirSync(join(dirs.cwd, '.pi'));
    writeFileSync(join(dirs.cwd, '.pi', 'settings.json'), JSON.stringify({ defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-pro' }));
    await sessions.configure(id, { harness: 'pi', config: { provider: 'local-only', model: 'local-model' } });
  }
  await until(() => !!sessions.current('a') && !!sessions.current('b'), 'both independently configured Pi instances must start');
  store.receive({ agent_id: 'b', channel_id: 'direct', message: { message_id: 'two', channel_type: 'im_direct',
    conversation_id: 'two', sender_id: 'human', sender_kind: 'human', message_seq: 1, content: 'agent-b-input',
    mentioned_agent_ids: ['b'], quoted_message_id: null, created_at: Date.now() } });
  dispatcher.wake('b');
  await until(() => requests.length === 2 && sessions.view('a').status === 'idle' && sessions.view('b').status === 'idle', 'both model calls must settle');
  assert.deepEqual(requests.map(r => r.key).sort(), ['Bearer agent-a-key', 'Bearer agent-b-key']);
  for (const id of ['a', 'b']) {
    const record = store.session(id)!; const saved = JSON.parse(record.config_json);
    assert.equal(saved.provider, undefined); assert.equal(saved.model, undefined);
    const settings = JSON.parse(readFileSync(join(saved.pi_config_dir, 'settings.json'), 'utf8'));
    assert.equal(settings.defaultProvider, 'local-only'); assert.deepEqual(settings.retry, { enabled: false });
    assert(!JSON.stringify(sessions.runtimeConfig(id)).includes(`agent-${id}-key`));
    assert(existsSync(JSON.parse(record.native_ref_json!).session_file));
  }
  assert.equal(store.session('a')!.session_id, original.session_id);
  dispatcher.stop(); await sessions.close(); await dispatcher.drain();
  // Remove only A's selection: its history and B's valid configuration cannot supply a fallback model.
  writeFileSync(join(aDir, 'settings.json'), '{}');
  sessions = new Sessions(store, config); dispatcher = new Dispatcher(store, sessions);
  sessions.onReady = id => dispatcher.wake(id); sessions.startAll(); dispatcher.start();
  await until(() => sessions.view('a').status === 'unconfigured' && sessions.view('b').status === 'idle', 'restart must preserve independent configuration states');
  assert.equal(sessions.view('a').model, null); assert.equal(requests.length, 2, 'history must not replay');
});
