import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigurationError } from '../model/errors.ts';
import { assertConfigComplete, readPrivateConfig } from './files.ts';

export interface ModelSelection { provider?: string; model?: string }

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
