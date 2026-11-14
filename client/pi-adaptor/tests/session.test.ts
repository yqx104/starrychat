import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { PiSession, InputError, type OpenConfig, type SessionEvent } from '../src/index.ts';

const cliPath = fileURLToPath(new URL('./fixtures/rpc.mjs', import.meta.url));
const resources = new Map<string, PiSession[]>();
function create(config: OpenConfig) {
  const session = new PiSession(config);
  resources.get(config.cwd)!.push(session);
  return session;
}
function fixture(t: TestContext, settings = {}): OpenConfig {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-adaptor-'));
  resources.set(cwd, []);
  t.after(async () => {
    for (const session of resources.get(cwd) ?? []) await session.close();
    resources.delete(cwd); rmSync(cwd, { recursive: true, force: true });
  });
  writeFileSync(join(cwd, 'fixture.json'), JSON.stringify(settings));
  return { cliPath, cwd, sessionDir: join(cwd, 'sessions'), settings: { pi_config_dir: join(cwd, 'config') },
    nativeRef: { session_id: randomUUID(), session_file: null }, allowCreate: true };
}
function commands(config: OpenConfig): any[] { return readFileSync(join(config.cwd, 'commands.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); }

test('native RpcClient starts, steers, maps safe events and restores the exact persisted session', async t => {
  const config = fixture(t);
  const events: SessionEvent[] = [];
  const session = create(config); session.onEvent(event => events.push(event));
  t.after(() => session.close());
  const empty = await session.open(); assert.equal(empty.nativeRef.session_file, null);
  assert.equal((await session.sendInput({ id: 1, text: 'first' })).disposition, 'started');
  assert.equal((await session.sendInput({ id: 2, text: 'second' })).disposition, 'queued');
  assert.equal((await session.sendInput({ id: 3, text: 'HANDLED' })).disposition, 'handled');
  const state = await session.getState(); assert(state.nativeRef.session_file); assert.equal(state.status, 'busy');
  assert.deepEqual([...await session.persistedInputs()], ['first']);
  assert(commands(config).filter(command => command.type === 'prompt').every(command => command.streamingBehavior === 'steer'));
  assert(events.some(event => event.type === 'text')); assert(events.some(event => event.type === 'tool'));
  assert(!JSON.stringify(events).includes('must-not-be-exposed'));
  await session.abort(); await session.close();
  const restored = create({ ...config, allowCreate: false, nativeRef: state.nativeRef });
  t.after(() => restored.close());
  assert.equal((await restored.open()).nativeRef.session_id, config.nativeRef.session_id);
  assert.deepEqual([...await restored.persistedInputs()], ['first']);
  // File created before the SQLite path update is found by exact native identity.
  await restored.close();
  const found = create({ ...config, allowCreate: false }); t.after(() => found.close());
  assert.equal((await found.open()).nativeRef.session_file, state.nativeRef.session_file);
});

test('known preflight rejections differ from ambiguous process exits', async t => {
  const session = create(fixture(t)); t.after(() => session.close()); await session.open();
  await assert.rejects(session.sendInput({ id: 1, text: 'TRANSIENT' }), error => error instanceof InputError && error.kind === 'retryable');
  await assert.rejects(session.sendInput({ id: 2, text: 'REJECT' }), error => error instanceof InputError && error.kind === 'rejected');
  await assert.rejects(session.sendInput({ id: 3, text: 'CRASH' }), error => error instanceof InputError && error.kind === 'unknown');
});

test('agent_end does not imply settled, even while the raw streaming flag is false', async t => {
  const session = create(fixture(t, { endWithoutSettled: true }));
  await session.open(); await session.sendInput({ id: 1, text: 'retrying turn' });
  assert.equal((await session.getState()).status, 'busy');
  await session.abort();
  await delay(20);
  assert.equal((await session.getState()).status, 'idle');
});

test('missing history and a mismatched native identity never silently create a new session', async t => {
  const config = fixture(t);
  const missing = create({ ...config, nativeRef: { ...config.nativeRef, session_file: join(config.cwd, 'missing.jsonl') } });
  await assert.rejects(missing.open(), /文件缺失/);
  const unknown = create({ ...config, allowCreate: false });
  await assert.rejects(unknown.open(), /无法确认 Pi 历史/);
  const wrong = create(fixture(t, { wrongIdentity: true })); t.after(() => wrong.close());
  await assert.rejects(wrong.open(), /身份发生变化/);
});

test('10-second probes do not overlap and late checks cannot publish after close', async t => {
  const config = fixture(t, { stateDelayMs: 150 });
  const session = create(config); t.after(() => session.close());
  const events: SessionEvent[] = []; session.onEvent(event => events.push(event));
  await session.open();
  t.mock.timers.enable({ apis: ['setInterval'] });
  // Timer was created before mock activation: create another instance with its timer under the mock.
  await session.close();
  const monitored = create(config); t.after(() => monitored.close());
  monitored.onEvent(event => events.push(event)); await monitored.open();
  const before = commands(config).filter(command => command.type === 'get_state').length;
  t.mock.timers.tick(10000); t.mock.timers.tick(10000); t.mock.timers.tick(10000);
  await delay(25);
  assert.equal(commands(config).filter(command => command.type === 'get_state').length, before + 1);
  await monitored.close(); const count = events.length;
  t.mock.timers.tick(100000); await delay(200);
  assert.equal(events.length, count);
  assert(commands(config).filter(command => command.type === 'get_state').every(command => command.activeChecks === 0));
});

test('idle subprocess death is reported by the periodic state check', async t => {
  const config = fixture(t, { exitAfterMs: 400 });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const session = create(config); t.after(() => session.close());
  const events: SessionEvent[] = []; session.onEvent(event => events.push(event));
  await session.open(); await delay(500); t.mock.timers.tick(10000); await delay(20);
  assert(events.some(event => event.type === 'error' && event.phase === 'probe'));
});
