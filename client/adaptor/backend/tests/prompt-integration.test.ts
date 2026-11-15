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
import { prepareAgentDirectories } from '../src/service/directories.ts';
import { createApp } from '../src/http/server.ts';
import { Agents } from '../src/service/agents.ts';
import { Connections } from '../src/service/connections.ts';

async function until(condition: () => boolean, description: string) {
  for (let i = 0; i < 300; i++) { if (condition()) return; await delay(25); }
  assert.fail(description);
}

test('HTTP prompt modes reach two real Pi instances and survive default changes and restart without losing history', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'adaptor-prompts-'));
  const path = join(directory, 'db.sqlite');
  const db = new DatabaseSync(path); db.exec(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8')); db.close();
  const store = new Store(path);
  const config = { address: '127.0.0.1:4183', im_base_url: 'http://127.0.0.1:9', trigger_ws_url: 'ws://127.0.0.1:9',
    adaptor_id: 'test', sqlite_path: path, agent_root: join(directory, 'agents'),
    pi_cli_path: fileURLToPath(new URL('../../../../agents/pi/upstream/packages/coding-agent/dist/bundle/rpc-entry.js', import.meta.url)) };
  const requests: any[] = [];
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: {"id":"test","object":"chat.completion.chunk","model":"local-model","choices":[{"index":0,"delta":{"role":"assistant","content":"verified"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const address = model.address(); assert(address && typeof address === 'object');
  let sessions = new Sessions(store, config);
  const connections = new Connections(store, config);
  const http = createApp(config, new Agents(store, config, connections, sessions), sessions, () => store.ping());
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const httpAddress = http.address(); assert(httpAddress && typeof httpAddress === 'object');
  t.after(async () => {
    connections.close();
    await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
    await sessions.close(); store.close();
    await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections(); });
    rmSync(directory, { recursive: true, force: true });
  });
  const runtime = async (id: string, input?: object, status = 200) => {
    const response = await fetch(`http://127.0.0.1:${httpAddress.port}/agents/${id}/runtime`, input ? {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ harness: 'pi', config: input }),
    } : undefined);
    const text = await response.text(); assert.equal(response.status, status, text); return JSON.parse(text);
  };
  const prompts = { a: '你是 Agent A。\n  PROMPT_ONLY_A\n', b: '你是 Agent B。\nPROMPT_ONLY_B' };
  const extension = join(directory, 'extension.mjs'); writeFileSync(extension, 'export default function () {}');
  for (const id of ['a', 'b'] as const) {
    store.add({ agent_id: id, name: id, username: id, token: 'test-token', expires_at: Date.now() + 3600000 });
    store.enable(id, false);
    const dirs = prepareAgentDirectories(config, id);
    assert.equal((await runtime(id)).runtime.config.system_prompt.mode, 'default');
    mkdirSync(join(dirs.cwd, '.pi'));
    writeFileSync(join(dirs.cwd, '.pi', 'SYSTEM.md'), 'UNWANTED_WORKSPACE_PROMPT');
    writeFileSync(join(dirs.cwd, '.pi', 'APPEND_SYSTEM.md'), 'UNWANTED_WORKSPACE_APPEND');
    writeFileSync(join(dirs.pi_config_dir, 'APPEND_SYSTEM.md'), 'UNWANTED_PRIVATE_APPEND');
    writeFileSync(join(dirs.pi_config_dir, 'AGENTS.md'), `CONTEXT_FOR_${id}`);
    await runtime(id, { provider: 'local-only', model: 'local-model', base_url: `http://127.0.0.1:${address.port}/v1`,
      api: 'openai-completions', api_key: 'test-key', extensions: [extension], system_prompt: { mode: 'replace', text: prompts[id] } });
    assert.deepEqual((await runtime(id)).runtime.config.system_prompt, { mode: 'replace', text: prompts[id] });
    store.enable(id, true); await sessions.reconcile(id);
  }
  const send = async (id: string) => {
    const count = requests.length;
    assert.equal(sessions.view(id).status, 'idle');
    await sessions.current(id)!.session.sendInput({ id: String(count + 1), text: `input ${count + 1}` });
    await until(() => requests.length === count + 1 && sessions.view(id).status === 'idle', 'model request must settle');
    return requests[count];
  };
  const system = (request: any) => request.messages.filter((m: any) => ['system', 'developer'].includes(m.role)).map((m: any) => m.content).join('\n');
  for (const id of ['a', 'b'] as const) {
    const request = await send(id); const text = system(request);
    assert(text.includes(prompts[id].trim()));
    assert(!text.includes(prompts[id === 'a' ? 'b' : 'a'].trim()));
    assert(!text.includes('UNWANTED_'));
    assert(text.includes(`CONTEXT_FOR_${id}`));
    assert(text.includes(join(config.agent_root, id, 'workspace')));
    assert(request.tools.length > 0, 'replacing prompt must preserve executable tools');
  }
  const before = store.session('a')!;
  assert(existsSync(JSON.parse(before.native_ref_json!).session_file));
  const aDir = join(config.agent_root, 'a', 'pi-config');
  const files = Object.fromEntries(['auth.json', 'models.json', 'settings.json'].map(name => [name, readFileSync(join(aDir, name), 'utf8')]));
  await runtime('a', { system_prompt: { mode: 'default', text: '' } }, 409);
  store.enable('a', false); await sessions.reconcile('a');
  await runtime('a', { system_prompt: { mode: 'append', text: 'unsupported' } }, 400);
  await runtime('a', { system_prompt: { mode: 'replace', text: '  ' } }, 400);
  await runtime('a', { system_prompt: { mode: 'default', text: '' } });
  assert(!existsSync(join(aDir, 'SYSTEM.md')));
  assert.deepEqual((await runtime('a')).runtime.config.system_prompt, { mode: 'default', text: '' });
  assert.deepEqual(JSON.parse(store.session('a')!.config_json).extensions, [extension]);
  for (const [name, body] of Object.entries(files)) assert.equal(readFileSync(join(aDir, name), 'utf8'), body);
  await runtime('a', { provider: '', model: '', system_prompt: { mode: 'replace', text: prompts.a } });
  assert.equal((await runtime('a')).runtime.config.provider, undefined, 'explicit blank selection still clears the model');
  assert.equal(JSON.parse(readFileSync(join(aDir, 'auth.json'), 'utf8'))['local-only'].key, 'test-key');
  await runtime('a', { provider: 'local-only', model: 'local-model', system_prompt: { mode: 'default', text: '' } });
  store.enable('a', true); await sessions.reconcile('a');
  const defaultRequest = await send('a');
  assert.match(system(defaultRequest), /^You are a coding assistant running inside pi/);
  assert(!system(defaultRequest).includes('PROMPT_ONLY_'));
  assert(!system(defaultRequest).includes('UNWANTED_'));
  assert.equal(store.session('a')!.session_id, before.session_id);
  assert.equal(store.session('a')!.native_ref_json, before.native_ref_json);
  assert(defaultRequest.messages.filter((m: any) => m.role === 'user').length >= 2, 'old conversation is retained');
  await sessions.close(); sessions = new Sessions(store, config);
  await Promise.all(['a', 'b'].map(id => sessions.reconcile(id)));
  assert.equal(requests.length, 3, 'restart must not replay messages');
  assert.match(system(await send('a')), /^You are a coding assistant running inside pi/);
  assert(system(await send('b')).includes(prompts.b));
  assert.equal(store.session('a')!.native_ref_json, before.native_ref_json);
});
