import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { loadConfig } from '../src/config/config.ts';
import { Store } from '../src/repository/store.ts';

test('cmd entrypoints initialize an empty database, reject overwrites and shut down cleanly', { timeout: 15000 }, async t => {
  for (const [directory, extension] of [['src', 'ts'], ['dist', 'js']]) {
    await t.test(directory, async t => {
      const root = mkdtempSync(join(tmpdir(), 'adaptor-entrypoints-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const configPath = join(root, 'config.json');
      writeFileSync(configPath, JSON.stringify({ address: '127.0.0.1:0', adaptor_id: 'entrypoint-test',
        im_base_url: 'http://127.0.0.1:9', trigger_ws_url: 'ws://127.0.0.1:9', sqlite_path: 'test.sqlite' }));
      const config = loadConfig(configPath);
      assert.equal(config.pi_cli_path, fileURLToPath(new URL('../../../../agents/pi/upstream/packages/coding-agent/dist/bundle/rpc-entry.js', import.meta.url)));
      const init = fileURLToPath(new URL(`../${directory}/cmd/init-db.${extension}`, import.meta.url));
      const initialized = spawnSync(process.execPath, [init, configPath], { encoding: 'utf8', timeout: 5000 });
      assert.equal(initialized.status, 0, initialized.stderr);
      const store = new Store(config.sqlite_path); store.checkHealth(); store.close();
      const before = readFileSync(config.sqlite_path);
      const repeated = spawnSync(process.execPath, [init, configPath], { encoding: 'utf8', timeout: 5000 });
      assert.notEqual(repeated.status, 0);
      assert.match(repeated.stderr, /数据库已存在/);
      assert.deepEqual(readFileSync(config.sqlite_path), before);
      const main = fileURLToPath(new URL(`../${directory}/cmd/main.${extension}`, import.meta.url));
      const child = spawn(process.execPath, [main, configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = once(child, 'exit');
      t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
      let output = ''; let errors = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { errors += data; });
      for (let i = 0; i < 200 && !output.includes('Adaptor 已就绪：') && child.exitCode === null; i++) await delay(25);
      assert.match(output, /Adaptor 已就绪：/, errors);
      child.kill('SIGTERM');
      const [code, signal] = await exited;
      assert.equal(code, 0, errors); assert.equal(signal, null);
    });
  }
});
