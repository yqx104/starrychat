import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { saveModelConfiguration } from '../src/model-config.ts';
import { readSystemPrompt, validateSystemPrompt } from '../src/prompt-config.ts';

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pi-system-prompt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('prompt-only saves preserve exact text and model files; default removes only SYSTEM.md', t => {
  const directory = fixture(t);
  assert.deepEqual(readSystemPrompt(directory), { mode: 'default', text: '' });
  const text = '\uFEFF你是这个 Agent 的助手。\r\n  保留缩进与换行。\n';
  saveModelConfiguration(directory, { system_prompt: { mode: 'replace', text } });
  assert.deepEqual(fs.readdirSync(directory), ['SYSTEM.md'], 'prompt does not require model configuration');
  assert.deepEqual(readSystemPrompt(directory), { mode: 'replace', text });
  assert.equal(fs.statSync(join(directory, 'SYSTEM.md')).mode & 0o777, 0o600);
  const originals = { 'auth.json': '{"custom":{"type":"api_key","key":"stored-key"}}\n',
    'models.json': '{"providers":{}}\n', 'settings.json': '{"retry":{"enabled":false}}\n', 'APPEND_SYSTEM.md': 'leave this file alone' };
  for (const [name, body] of Object.entries(originals)) fs.writeFileSync(join(directory, name), body);
  saveModelConfiguration(directory, { system_prompt: { mode: 'default', text: '' } });
  assert.deepEqual(readSystemPrompt(directory), { mode: 'default', text: '' });
  assert(!fs.existsSync(join(directory, 'SYSTEM.md')));
  for (const [name, body] of Object.entries(originals)) assert.equal(fs.readFileSync(join(directory, name), 'utf8'), body);
});

test('invalid or external prompt files cannot become an active replacement', t => {
  const directory = fixture(t);
  for (const input of [null, [], { mode: 'append', text: 'x' }, { mode: 'replace', text: ' \n ' },
    { mode: 'default', text: 'x' }, { mode: 'default', text: null }, { mode: 'replace', text: '中'.repeat(22000) },
    { mode: 'replace', text: 'a\0b' }, { mode: 'replace', text: 'x', extra: true }]) {
    assert.throws(() => validateSystemPrompt(input));
  }
  assert.equal(validateSystemPrompt({ mode: 'replace', text: 'a'.repeat(65536) }).text.length, 65536);
  const path = join(directory, 'SYSTEM.md');
  fs.writeFileSync(path, Buffer.from([0xff]));
  assert.throws(() => readSystemPrompt(directory), /UTF-8/);
  fs.rmSync(path);
  const outside = fixture(t); fs.writeFileSync(join(outside, 'prompt'), 'outside');
  fs.symlinkSync(join(outside, 'prompt'), path);
  assert.throws(() => saveModelConfiguration(directory, { system_prompt: { mode: 'replace', text: 'new' } }), /配置目录内/);
  assert.equal(fs.readFileSync(join(outside, 'prompt'), 'utf8'), 'outside');
});

test('failed prompt writes and failed default saves roll back the whole configuration', t => {
  const directory = fixture(t);
  const choice = { provider: 'custom', model: 'model', base_url: 'http://127.0.0.1:9', api: 'openai-completions' };
  saveModelConfiguration(directory, { ...choice, api_key: 'old-key', system_prompt: { mode: 'replace', text: 'old prompt' } });
  const originals = Object.fromEntries(fs.readdirSync(directory).map(name => [name, fs.readFileSync(join(directory, name), 'utf8')]));
  const rename = fs.renameSync; let failed = false;
  const spy = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (!failed && String(to) === join(directory, 'SYSTEM.md')) { failed = true; throw new Error('simulated prompt write failure'); }
    return rename(from, to);
  });
  assert.throws(() => saveModelConfiguration(directory, { ...choice, api_key: 'new-key', system_prompt: { mode: 'replace', text: 'new prompt' } }), /已恢复原配置/);
  spy.mock.restore();
  const remove = fs.rmSync; failed = false;
  const removeSpy = t.mock.method(fs, 'rmSync', (path: fs.PathLike, options?: fs.RmOptions) => {
    if (!failed && String(path) === join(directory, '.config-save-pending')) { failed = true; throw new Error('simulated commit failure'); }
    return remove(path, options);
  });
  assert.throws(() => saveModelConfiguration(directory, { system_prompt: { mode: 'default', text: '' } }), /已恢复原配置/);
  removeSpy.mock.restore();
  assert.deepEqual(fs.readdirSync(directory).sort(), Object.keys(originals).sort());
  for (const [name, body] of Object.entries(originals)) assert.equal(fs.readFileSync(join(directory, name), 'utf8'), body);
});
