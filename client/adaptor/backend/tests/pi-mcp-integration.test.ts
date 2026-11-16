import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Store } from '../src/repository/store.ts';
import { Sessions } from '../src/service/sessions.ts';
import { Dispatcher } from '../src/service/dispatch.ts';
import { Connections } from '../src/service/connections.ts';
import { Agents } from '../src/service/agents.ts';
import { ImMcp } from '../src/service/im-mcp.ts';
import { createApp } from '../src/http/server.ts';
import { createSession } from '../src/clients/harnesses.ts';
import { prepareAgentDirectories } from '../src/service/directories.ts';

const agent = '01900000-0000-7000-8000-000000000011';
const other = '01900000-0000-7000-8000-000000000012';
const conversation = '01900000-0000-7000-8000-000000000013';
const original = '01900000-0000-7000-8000-000000000014';
const reply = '01900000-0000-7000-8000-000000000015';

test('real Pi loads private MCP configuration, reads IM context, sends a quoted @ reply and restores after restart', { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-im-mcp-'));
  const requests: any[] = []; const errors: unknown[] = []; const sends: any[] = [];
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    let delta: object; let toolCall = false;
    try {
      const toolNames = body.tools.map((tool: any) => tool.function.name);
      assert(toolNames.includes('mcp__starrychat__im_list_messages'), JSON.stringify(toolNames));
      assert(toolNames.includes('mcp__starrychat__im_send_message'));
      assert.equal(toolNames.filter((name: string) => name.startsWith('mcp__starrychat__')).length, 6);
      if (requests.length === 1 || requests.length === 2) {
        toolCall = true;
        if (requests.length === 2) assert(JSON.stringify(body.messages).includes('background context from IM'));
        delta = { role: 'assistant', tool_calls: [{ index: 0, id: `call_im_${requests.length}`, type: 'function', function: {
          name: requests.length === 1 ? 'mcp__starrychat__im_list_messages' : 'mcp__starrychat__im_send_message',
          arguments: JSON.stringify(requests.length === 1 ? { conversation_id: conversation, after_seq: 0 } :
            { conversation_id: conversation, content: 'checked the context', quoted_message_id: original, mentioned_agent_ids: [other] }),
        } }] };
      } else {
        assert(JSON.stringify(body.messages).includes(reply));
        delta = { role: 'assistant', content: '已通过 IM 回复。' };
      }
    } catch (error) { errors.push(error); delta = { role: 'assistant', content: 'test failed' }; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }]) {
      response.write(`data: ${JSON.stringify({ id: 'mcp-test', object: 'chat.completion.chunk', created: 1, model: 'local-model', choices: [choice] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  const im = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer private-im-credential');
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const message = { message_id: original, conversation_id: conversation, message_seq: 1, sender_id: other,
      content: 'background context from IM', mentioned_agent_ids: [], quoted_message_id: null, created_at: 1 };
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET') {
      assert.equal(request.url, `/conversations/${conversation}/messages?limit=20&after_seq=0`);
      response.end(JSON.stringify({ messages: [message], has_more: false }));
    } else {
      assert.equal(request.url, `/conversations/${conversation}/messages`);
      const input = JSON.parse(Buffer.concat(chunks).toString()); sends.push(input);
      response.statusCode = 201;
      response.end(JSON.stringify({ message: { ...message, ...input, message_id: reply, message_seq: 2, sender_id: agent } }));
    }
  });
  model.listen(0, '127.0.0.1'); im.listen(0, '127.0.0.1');
  await Promise.all([once(model, 'listening'), once(im, 'listening')]);
  const modelAddress = model.address(); const imAddress = im.address();
  assert(modelAddress && typeof modelAddress === 'object'); assert(imAddress && typeof imAddress === 'object');
  const dbPath = join(root, 'adaptor.sqlite'); const db = new DatabaseSync(dbPath);
  db.exec(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8')); db.close();
  const store = new Store(dbPath);
  const config = { address: '127.0.0.1:0', adaptor_id: 'pi-mcp-test', sqlite_path: dbPath, agent_root: join(root, 'agents'),
    im_base_url: `http://127.0.0.1:${imAddress.port}`, trigger_ws_url: 'ws://127.0.0.1:9',
    pi_cli_path: fileURLToPath(new URL('../../../../agents/pi/upstream/packages/coding-agent/dist/bundle/rpc-entry.js', import.meta.url)) };
  const directories = prepareAgentDirectories(config, agent);
  writeFileSync(join(directories.pi_config_dir, 'models.json'), JSON.stringify({ providers: { 'local-mcp-test': {
    baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`, api: 'openai-completions', apiKey: 'private-model-credential',
    models: [{ id: 'local-model', name: 'Local model', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }), { mode: 0o600 });
  writeFileSync(join(directories.pi_config_dir, 'settings.json'), JSON.stringify({ defaultProvider: 'local-mcp-test', defaultModel: 'local-model',
    retry: { enabled: false }, compaction: { enabled: false } }));
  store.add({ agent_id: agent, name: 'Pi MCP', username: 'pi-mcp', token: 'private-im-credential', expires_at: Date.now() + 3600000 });
  store.configure(agent, directories.cwd, { pi_config_dir: directories.pi_config_dir });
  const mcp = new ImMcp(store, config);
  const sessions = new Sessions(store, config, createSession, id => [mcp.connection(id)]);
  const connections = new Connections(store, config);
  const agents = new Agents(store, config, connections, sessions);
  const dispatcher = new Dispatcher(store, sessions); sessions.onReady = id => dispatcher.wake(id);
  const app = createApp(config, agents, sessions, () => store.checkHealth(), mcp);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => {
    connections.close(); dispatcher.stop(); await sessions.close(); await dispatcher.drain();
    await Promise.all([app, model, im].map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
    store.close(); rmSync(root, { recursive: true, force: true });
  });
  const receive = (id: string, content: string) => store.receive({ agent_id: agent, channel_id: conversation, message: {
    message_id: id, channel_type: 'im_group', conversation_id: conversation, message_seq: 1, sender_id: other, sender_kind: 'agent',
    content, mentioned_agent_ids: [agent], quoted_message_id: null, created_at: 1,
  } });
  receive(original, 'Read the history and reply with a quote and mention.');
  await sessions.reconcile(agent); dispatcher.start();
  assert.equal(sessions.view(agent).status === 'error' || sessions.view(agent).status === 'unconfigured', false, sessions.view(agent).last_error ?? 'Pi startup');
  for (let i = 0; i < 500 && !(requests.length >= 3 && sessions.view(agent).status === 'idle') && !errors.length; i++) await delay(25);
  assert.deepEqual(errors, []);
  assert.equal(requests.length, 3, JSON.stringify(sessions.view(agent)));
  assert.equal(sessions.view(agent).status, 'idle');
  assert.deepEqual(sends, [{ content: 'checked the context', quoted_message_id: original, mentioned_agent_ids: [other] }]);
  const view = sessions.view(agent); const id = view.session!.session_id;
  const events = sessions.readEvents(id, 0).events;
  assert(events.some(event => event.type === 'tool' && event.tool === 'mcp__starrychat__im_send_message'));
  const localCredential = mcp.connection(agent).headers.Authorization.split(' ')[1];
  for (const secret of [localCredential, 'private-im-credential', 'private-model-credential']) {
    assert(!JSON.stringify({ requests, view, events, config: sessions.runtimeConfig(agent) }).includes(secret));
  }
  const nativeId = view.session!.native_ref!.session_id;
  store.enable(agent, false); await sessions.reconcile(agent);
  store.enable(agent, true); await sessions.reconcile(agent);
  assert.equal(sessions.view(agent).session!.native_ref!.session_id, nativeId);
  assert.equal(mcp.connection(agent).headers.Authorization.split(' ')[1], localCredential);
  receive('01900000-0000-7000-8000-000000000016', 'Confirm the earlier IM reply.'); dispatcher.wake(agent);
  for (let i = 0; i < 400 && !(requests.length >= 4 && sessions.view(agent).status === 'idle'); i++) await delay(25);
  assert.deepEqual(errors, []); assert.equal(requests.length, 4); assert.equal(sends.length, 1, 'restoring Pi must not replay the send');
});
