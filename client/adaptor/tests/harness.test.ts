import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { ConfigurationError, type Harness, type Input, type OpenConfig, type SessionEvent } from '@starrychat/adaptor-contracts';
import { Store } from '../src/repository/store.ts';
import { Sessions } from '../src/service/sessions.ts';
import { Dispatcher } from '../src/service/dispatch.ts';

async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await delay(10); }
  assert.fail('Condition did not become true');
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'adaptor-harness-'));
  const path = join(root, 'db.sqlite');
  const db = new DatabaseSync(path); db.exec(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8')); db.close();
  const store = new Store(path);
  store.add({ agent_id: 'a', name: 'a', username: 'a', token: 'unused', expires_at: Date.now() + 3600000 });
  const config = { address: '127.0.0.1:4183', im_base_url: 'http://127.0.0.1:9', trigger_ws_url: 'ws://127.0.0.1:9',
    adaptor_id: 'test', sqlite_path: path, agent_root: join(root, 'agents') };
  const opened: OpenConfig[] = []; const sent: Input[] = []; const recovered: Input[][] = [];
  const durable = new Set<number>(); const listeners = new Set<(event: SessionEvent) => void>();
  let saves = 0; let closes = 0; let recoveryFails = false;
  const harness: Harness = {
    id: 'fixture',
    readConfig(context, settings) {
      return { config: settings ?? { flavour: 'default' }, directories: { cwd: context.cwd }, configuration_issue: null, choices: ['one', 'two'] };
    },
    validateConfig(input) {
      if (!input || typeof (input as { flavour?: unknown }).flavour !== 'string') throw new ConfigurationError('flavour required');
    },
    saveConfig(_context, input) { saves++; return { choice: (input as { flavour: string }).flavour }; },
    validateSession() {},
    createSession(options) {
      const nativeRef = options.nativeRef ?? { thread_key: 'opaque:thread', checkpoint: [7, 'v1'] };
      const state = { nativeRef, status: 'idle' as const, pending: 0, model: null };
      return {
        nativeRef,
        async open() {
          assert.deepEqual(JSON.parse(store.session('a')!.native_ref_json!), nativeRef, 'persist identity before starting the runtime');
          opened.push(options); return state;
        },
        onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        async getState() { return state; },
        async sendInput(input) {
          sent.push(input);
          if (sent.length === 1) durable.add(input.id);
          return { inputId: input.id, disposition: sent.length === 1 ? 'started' : 'queued' };
        },
        async recoverInputs(inputs) {
          recovered.push(inputs);
          if (recoveryFails) throw new Error('native evidence unavailable');
          return new Set(inputs.filter(input => durable.has(input.id)).map(input => input.id));
        },
        async abort() {},
        async close() { closes++; listeners.clear(); },
      };
    },
  };
  const instances: Sessions[] = []; const dispatchers: Dispatcher[] = [];
  const mcp = [{ name: 'im', url: 'http://127.0.0.1:4183/mcp', headers: { Authorization: 'Bearer fixture' } }];
  const start = () => {
    const sessions = new Sessions(store, config, [harness, { ...harness, id: 'other' }], () => mcp);
    const dispatcher = new Dispatcher(store, sessions); sessions.onReady = id => dispatcher.wake(id);
    instances.push(sessions); dispatchers.push(dispatcher);
    return { sessions, dispatcher };
  };
  t.after(async () => {
    for (const dispatcher of dispatchers) dispatcher.stop();
    for (const sessions of instances) await sessions.close();
    for (const dispatcher of dispatchers) await dispatcher.drain();
    store.close(); rmSync(root, { recursive: true, force: true });
  });
  const receive = (id: string) => store.receive({ agent_id: 'a', channel_id: 'direct', message: {
    message_id: id, channel_type: 'im_direct', conversation_id: 'direct', message_seq: 1, sender_id: 'human', sender_kind: 'human',
    content: id, mentioned_agent_ids: [], quoted_message_id: null, created_at: Date.now(),
  } });
  const inbox = () => store.inbox('a', Number.MAX_SAFE_INTEGER, 100).messages;
  return { root, store, harness, start, receive, inbox, opened, sent, recovered, mcp,
    saves: () => saves, closes: () => closes,
    failRecovery: () => { recoveryFails = true; },
    emit: (event: SessionEvent) => { for (const listener of listeners) listener(event); } };
}

test('shared scheduling delegates configuration and resumes opaque native references with ID-based recovery', async t => {
  const f = fixture(t); const { sessions, dispatcher } = f.start();
  assert.equal(sessions.runtimeConfig('a').runtime.harness, 'fixture');
  assert.deepEqual(sessions.runtimeConfig('a').choices, ['one', 'two']);
  await sessions.configure('a', { harness: 'fixture', config: { flavour: 'one' } });
  const original = f.store.session('a')!;
  assert.equal(original.harness, 'fixture'); assert.deepEqual(JSON.parse(original.config_json), { choice: 'one' });
  assert.deepEqual(f.opened[0].mcpServers, f.mcp);
  assert.deepEqual(readdirSync(join(f.root, 'agents', 'a')).sort(), ['sessions', 'workspace']);
  await assert.rejects(sessions.configure('a', { harness: 'fixture', config: {} }), /flavour required/);
  await assert.rejects(sessions.configure('a', { harness: 'fixture', config: { flavour: 'two' } }), /先停用/);
  assert.equal(f.saves(), 1);
  f.receive('durable'); f.receive('queued'); dispatcher.start();
  await until(() => f.inbox().every(row => row.state === 'accepted'));
  dispatcher.stop(); await sessions.close(); await dispatcher.drain();
  assert.deepEqual(f.inbox().map(row => row.state), ['needs_recovery', 'accepted']);
  assert.deepEqual(f.recovered[0].map(input => input.id), f.sent.map(input => input.id));

  const restarted = f.start(); await restarted.sessions.reconcile('a'); restarted.dispatcher.start();
  assert.equal(f.opened[1].allowCreate, false);
  assert.deepEqual(f.opened[1].nativeRef, JSON.parse(original.native_ref_json!));
  assert.equal(restarted.sessions.view('a').blocked, 'needs_recovery');
  assert.equal(f.sent.length, 2, 'uncertain input must never be automatically replayed');
  f.store.enable('a', false); await restarted.sessions.reconcile('a');
  await restarted.sessions.configure('a', { harness: 'fixture', config: { flavour: 'two' } });
  assert.deepEqual(JSON.parse(f.store.session('a')!.config_json), { choice: 'two' });
  assert.equal(f.store.session('a')!.session_id, original.session_id);
  assert.equal(f.store.session('a')!.native_ref_json, original.native_ref_json);
});

test('generic fatal events stop dispatch and unavailable recovery evidence cannot trigger a resend', async t => {
  const f = fixture(t); const { sessions, dispatcher } = f.start();
  await sessions.configure('a', { harness: 'fixture', config: { flavour: 'one' } });
  await assert.rejects(sessions.configure('a', { harness: 'unknown', config: {} }), /未注册/);
  await assert.rejects(sessions.configure('a', { harness: 'other', config: { flavour: 'one' } }), /不能直接切换/);
  f.receive('first'); dispatcher.start(); await until(() => f.inbox()[0].state === 'accepted');
  f.failRecovery();
  f.emit({ type: 'error', phase: 'transport_disconnected', fatal: true, text: 'fixture disconnected' });
  await until(() => f.closes() > 0 && f.inbox()[0].state === 'needs_recovery');
  assert.equal(sessions.view('a').status, 'error'); assert.equal(sessions.current('a'), undefined);
  f.receive('later'); dispatcher.wake('a');
  assert.equal(f.inbox()[0].state, 'pending'); assert.equal(f.sent.length, 1);
});
