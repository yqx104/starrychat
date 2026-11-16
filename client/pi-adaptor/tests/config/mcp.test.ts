import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configureMcp } from '../../src/config/mcp.ts';

test('managed MCP configuration stays private, preserves other servers and refreshes before Pi starts', t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-mcp-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'config'); mkdirSync(directory);
  const path = join(directory, 'mcp.json');
  writeFileSync(path, JSON.stringify({ autoEnableCodemode: false, mcpServers: {
    docs: { url: 'https://example.test/mcp' }, starrychat: { command: 'obsolete', enabled: false },
  } }));
  configureMcp(directory, root, [{ name: 'starrychat', url: 'http://127.0.0.1:4183/mcp', headers: { Authorization: 'Bearer local-mcp-key' } }]);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(config, { autoEnableCodemode: false, mcpServers: {
    docs: { url: 'https://example.test/mcp' },
    starrychat: { type: 'http', url: 'http://127.0.0.1:4183/mcp', headers: { Authorization: 'Bearer local-mcp-key' }, exposure: 'direct', enabled: true },
  } });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  configureMcp(directory, root, [{ name: 'starrychat', url: 'http://127.0.0.1:4184/mcp', headers: { Authorization: 'Bearer replacement-key' } }]);
  assert(!readFileSync(path, 'utf8').includes('local-mcp-key'));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).mcpServers.starrychat.url, 'http://127.0.0.1:4184/mcp');
});

test('damaged configuration, escaping symlinks and project identity overrides are rejected without overwriting', t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-mcp-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'config'); mkdirSync(directory);
  const path = join(directory, 'mcp.json');
  const connection = [{ name: 'starrychat', url: 'http://127.0.0.1:4183/mcp' }];
  for (const invalid of ['not-json', '{"mcpServers":[]}']) {
    writeFileSync(path, invalid);
    assert.throws(() => configureMcp(directory, root, connection));
    assert.equal(readFileSync(path, 'utf8'), invalid);
  }
  rmSync(path);
  const external = join(root, 'external.json'); writeFileSync(external, '{}'); symlinkSync(external, path);
  assert.throws(() => configureMcp(directory, root, connection), /目录内/);
  assert.equal(readFileSync(external, 'utf8'), '{}');
  rmSync(path); writeFileSync(path, '{}');
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { starrychat: { enabled: false } } }));
  assert.throws(() => configureMcp(directory, root, connection), /不能覆盖/);
  assert.equal(readFileSync(path, 'utf8'), '{}');
});
