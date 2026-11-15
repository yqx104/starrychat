import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isolatedEnvironment, readModelSelection, writeModelSelection } from '../src/config.ts';
import { ConfigurationError } from '../src/types.ts';

test('private environment is a minimal allowlist and each instance has its own config directory', t => {
  const old = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'host-must-not-be-inherited';
  t.after(() => { if (old === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = old; });
  const a = isolatedEnvironment('/agent-a/pi-config');
  const b = isolatedEnvironment('/agent-b/pi-config');
  assert.equal(a.DEEPSEEK_API_KEY, undefined);
  assert.equal(a.NODE_OPTIONS, undefined);
  assert.equal(a.PI_ADAPTOR_CONFIG_ONLY, '1');
  assert.equal(a.PI_CODING_AGENT_DIR, '/agent-a/pi-config');
  assert.equal(b.PI_CODING_AGENT_DIR, '/agent-b/pi-config');
});

test('model selection is saved privately without discarding unrelated Pi settings or overwriting corrupt files', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-selection-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
  writeModelSelection(directory, { provider: 'agent', model: 'model' });
  assert.deepEqual(readModelSelection(directory), { provider: 'agent', model: 'model' });
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8')).retry, { enabled: false });
  writeModelSelection(directory, {});
  assert.deepEqual(readModelSelection(directory), { provider: undefined, model: undefined });
  writeFileSync(join(directory, 'settings.json'), '{invalid-private-content');
  assert.throws(() => readModelSelection(directory), ConfigurationError);
  assert.throws(() => writeModelSelection(directory, {}), ConfigurationError);
  assert.equal(readFileSync(join(directory, 'settings.json'), 'utf8'), '{invalid-private-content');
});
