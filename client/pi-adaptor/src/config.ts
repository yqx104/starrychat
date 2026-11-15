import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigurationError } from './types.ts';

export interface ModelSelection { provider?: string; model?: string }

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
  const settings = readPrivateConfig(directory, 'settings.json');
  for (const key of ['defaultProvider', 'defaultModel']) {
    if (settings[key] !== undefined && (typeof settings[key] !== 'string' || !settings[key].trim())) {
      throw new ConfigurationError('请检查 pi-config/settings.json 中的 defaultProvider 和 defaultModel');
    }
  }
  return { provider: settings.defaultProvider as string | undefined, model: settings.defaultModel as string | undefined };
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
