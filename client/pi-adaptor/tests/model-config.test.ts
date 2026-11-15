import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { readModelOptions, saveModelConfiguration } from '../src/model-config.ts';
import { readModelSelection } from '../src/config.ts';

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pi-model-form-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const read = (name: string) => JSON.parse(fs.readFileSync(join(directory, name), 'utf8'));
  const write = (name: string, value: unknown) => fs.writeFileSync(join(directory, name), JSON.stringify(value));
  return { directory, read, write };
}

test('form config keeps builtin metadata and other providers, hides secrets and supports retain/replace/clear', t => {
  const f = fixture(t);
  f.write('settings.json', { retry: { enabled: false } });
  f.write('auth.json', { other: { type: 'oauth', access: 'private-access', refresh: 'private-refresh', expires: 9999999999999 } });
  f.write('models.json', { providers: { other: { baseUrl: 'https://other.example/v1', api: 'openai-completions',
    headers: { Authorization: 'private-header' }, models: [{ id: 'other-model', contextWindow: 32000 }] } } });
  const choice = { provider: 'deepseek', model: 'deepseek-v4-pro', base_url: 'https://proxy.example/v1/', api: 'openai-completions' };
  saveModelConfiguration(f.directory, { ...choice, api_key: 'private-agent-key' });
  assert.deepEqual(f.read('models.json').providers.deepseek, { baseUrl: 'https://proxy.example/v1' });
  assert.equal(f.read('models.json').providers.other.models[0].contextWindow, 32000);
  assert.deepEqual(f.read('settings.json').retry, { enabled: false });
  assert.equal(f.read('auth.json').other.access, 'private-access');
  assert.deepEqual(readModelSelection(f.directory), { provider: choice.provider, model: choice.model });
  const options = readModelOptions(f.directory); const selected = options.find(p => p.id === 'deepseek')!;
  assert(selected.has_api_key); assert(selected.models.find(m => m.id === choice.model)!.builtin);
  assert(!JSON.stringify(options).includes('private-'));
  saveModelConfiguration(f.directory, { ...choice, api_key: '' });
  assert.equal(f.read('auth.json').deepseek.key, 'private-agent-key');
  saveModelConfiguration(f.directory, { ...choice, api_key: '!literal-$KEY' });
  assert.equal(f.read('auth.json').deepseek.key, '$!literal-$$KEY');
  saveModelConfiguration(f.directory, { ...choice, clear_api_key: true });
  assert.equal(f.read('auth.json').deepseek, undefined);
  assert.equal(readModelOptions(f.directory).find(p => p.id === 'deepseek')!.has_api_key, false);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  for (const name of ['auth.json', 'models.json', 'settings.json']) assert.equal(fs.statSync(join(f.directory, name)).mode & 0o777, 0o600);
});

test('legacy keys move to auth.json; clearing never resurrects a models.json key or removes other authentication', t => {
  const f = fixture(t);
  f.write('models.json', { providers: { custom: { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'legacy-key',
    models: [{ id: 'model', contextWindow: 8192, maxTokens: 256, compat: { maxTokensField: 'max_tokens' } }] } } });
  const choice = { provider: 'custom', model: 'model' };
  saveModelConfiguration(f.directory, choice);
  assert.equal(f.read('auth.json').custom.key, 'legacy-key');
  assert.equal(f.read('models.json').providers.custom.apiKey, undefined);
  assert.equal(f.read('models.json').providers.custom.models[0].maxTokens, 256);
  const models = f.read('models.json'); models.providers.custom.apiKey = 'old-fallback'; f.write('models.json', models);
  saveModelConfiguration(f.directory, { ...choice, clear_api_key: true });
  assert.equal(f.read('auth.json').custom, undefined);
  assert.equal(f.read('models.json').providers.custom.apiKey, undefined);
  assert.equal(readModelOptions(f.directory).find(p => p.id === 'custom')!.has_api_key, false);
  saveModelConfiguration(f.directory, { provider: 'another', model: 'new-model', base_url: 'http://127.0.0.1:9', api: 'openai-completions', api_key: 'another-key' });
  saveModelConfiguration(f.directory, choice);
  assert.equal(f.read('auth.json').custom, undefined, 'switching providers must not copy keys');
  assert.equal(f.read('auth.json').another.key, 'another-key');
});

test('validation and a failed middle write preserve the original config; interrupted saves cannot start Pi', t => {
  const f = fixture(t);
  const choice = { provider: 'custom', model: 'model', base_url: 'http://127.0.0.1:9/v1', api: 'openai-completions' };
  saveModelConfiguration(f.directory, { ...choice, api_key: 'before-key' });
  const before = Object.fromEntries(['auth.json', 'models.json', 'settings.json'].map(name => [name, fs.readFileSync(join(f.directory, name), 'utf8')]));
  for (const invalid of [
    { base_url: 'https://user:private-password@example.com' }, { base_url: 'https://example.com?key=private-key' },
    { api: 'unsupported-protocol' }, { api_key: 'new', clear_api_key: true }, { provider: '__proto__' },
  ]) assert.throws(() => saveModelConfiguration(f.directory, { ...choice, ...invalid }));
  const rename = fs.renameSync; let failed = false;
  const spy = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (!failed && String(to) === join(f.directory, 'models.json')) { failed = true; throw new Error('simulated write failure'); }
    return rename(from, to);
  });
  assert.throws(() => saveModelConfiguration(f.directory, { ...choice, api_key: 'after-key', base_url: 'http://127.0.0.1:8' }), /已恢复原配置/);
  spy.mock.restore();
  for (const [name, content] of Object.entries(before)) assert.equal(fs.readFileSync(join(f.directory, name), 'utf8'), content);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['auth.json', 'models.json', 'settings.json']);
  f.write('auth.json', { custom: [] });
  assert.throws(() => saveModelConfiguration(f.directory, choice), /auth.json/);
  assert.deepEqual(f.read('auth.json'), { custom: [] });
  fs.writeFileSync(join(f.directory, '.config-save-pending'), 'interrupted');
  assert.throws(() => readModelSelection(f.directory), /未完成/);
});
