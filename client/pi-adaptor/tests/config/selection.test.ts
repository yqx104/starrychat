import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readModelSelection, writeModelSelection } from '../../src/config/selection.ts';
import { ConfigurationError } from '../../src/model/errors.ts';

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
