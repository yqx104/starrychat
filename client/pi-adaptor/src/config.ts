import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigurationError } from './types.ts';
import fs from 'node:fs';

export interface ModelSelection { provider?: string; model?: string }

export function assertConfigComplete(directory: string) {
  if (existsSync(join(directory, '.config-save-pending'))) {
    throw new ConfigurationError('上次配置保存未完成，请核对并恢复 pi-config 文件后移除 .config-save-pending 标记');
  }
}

export function readPrivateConfig(directory: string, name: 'settings.json' | 'auth.json' | 'models.json'): Record<string, unknown> {
  const path = join(directory, name);
  if (!existsSync(path)) return {};
  try {
    const inside = relative(realpathSync(directory), realpathSync(path));
    if (inside.startsWith('..') || isAbsolute(inside)) throw new Error();
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ConfigurationError(`请检查 pi-config/${name}：必须是目录内可读取的 JSON 对象`); }
}

export function readModelSelection(directory: string): ModelSelection {
  assertConfigComplete(directory);
  const settings = readPrivateConfig(directory, 'settings.json');
  for (const key of ['defaultProvider', 'defaultModel']) {
    if (settings[key] !== undefined && (typeof settings[key] !== 'string' || !settings[key].trim())) {
      throw new ConfigurationError('请检查 pi-config/settings.json 中的 defaultProvider 和 defaultModel');
    }
  }
  return { provider: settings.defaultProvider as string | undefined, model: settings.defaultModel as string | undefined };
}

// Serialize callers per Agent. Each file is replaced atomically; an interrupted
// group is marked so a subsequent process cannot start using partial settings.
export function writePrivateConfigs(directory: string, values: Record<string, Record<string, unknown>>) {
  assertConfigComplete(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const before = new Map<string, string | undefined>();
  for (const name of Object.keys(values)) {
    const path = join(directory, name);
    before.set(name, existsSync(path) ? readFileSync(path, 'utf8') : undefined);
  }
  const marker = join(directory, '.config-save-pending');
  const replace = (name: string, content: string) => {
    const temporary = join(directory, `.config-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, join(directory, name));
    } finally { fs.rmSync(temporary, { force: true }); }
  };
  fs.writeFileSync(marker, 'Configuration save in progress\n', { mode: 0o600, flag: 'wx' });
  const changed: string[] = [];
  try {
    for (const [name, value] of Object.entries(values)) {
      replace(name, JSON.stringify(value, null, 2) + '\n'); changed.push(name);
    }
    fs.rmSync(marker);
  } catch {
    try {
      for (const name of changed.reverse()) {
        const content = before.get(name);
        if (content === undefined) fs.rmSync(join(directory, name), { force: true });
        else replace(name, content);
      }
      fs.rmSync(marker);
    } catch { throw new ConfigurationError('配置保存及恢复失败；Pi 将保持待配置，请核对 pi-config 文件和目录权限'); }
    throw new ConfigurationError('配置保存失败，已恢复原配置，请检查 pi-config 目录权限');
  }
}

export function writeModelSelection(directory: string, selection: ModelSelection) {
  const settings = readPrivateConfig(directory, 'settings.json');
  if (selection.provider && selection.model) {
    settings.defaultProvider = selection.provider; settings.defaultModel = selection.model;
  } else { delete settings.defaultProvider; delete settings.defaultModel; }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.settings-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, join(directory, 'settings.json'));
  } finally { rmSync(temporary, { force: true }); }
}

export function isolatedEnvironment(directory: string): Record<string, string> {
  const env: Record<string, string> = {};
  // Keep process essentials; never copy the host's model, auth, cloud or Node preload settings.
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return { ...env, PI_CODING_AGENT_DIR: directory, PI_ADAPTOR_CONFIG_ONLY: '1' };
}
