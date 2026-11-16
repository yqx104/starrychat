import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { assertConfigComplete } from './files.ts';
import { ConfigurationError } from '../model/errors.ts';

export const maxSystemPromptBytes = 64 * 1024;
export interface SystemPromptConfiguration { mode: 'default' | 'replace'; text: string }

export function validateSystemPrompt(value: unknown): SystemPromptConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigurationError('system_prompt 必须为对象');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['mode', 'text'].includes(key)) || !['default', 'replace'].includes(input.mode as string)) {
    throw new ConfigurationError('系统提示词只支持 Pi 默认和替换两种模式');
  }
  const text = input.text === undefined ? '' : input.text;
  if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text, 'utf8') > maxSystemPromptBytes) {
    throw new ConfigurationError('系统提示词必须为有效文本，UTF-8 长度不能超过 64 KiB');
  }
  if (input.mode === 'replace' && !text.trim()) throw new ConfigurationError('替换模式需要填写系统提示词');
  if (input.mode === 'default' && text !== '') throw new ConfigurationError('Pi 默认模式不接受自定义系统提示词');
  return { mode: input.mode as SystemPromptConfiguration['mode'], text };
}

export function readSystemPrompt(directory: string): SystemPromptConfiguration {
  assertConfigComplete(directory);
  const path = join(directory, 'SYSTEM.md');
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { mode: 'default', text: '' };
    throw new ConfigurationError('无法读取 pi-config/SYSTEM.md，请检查文件权限');
  }
  let text: string;
  try {
    const inside = relative(realpathSync(directory), realpathSync(path));
    const info = statSync(path);
    if (inside.startsWith('..') || isAbsolute(inside) || !info.isFile() || info.size > maxSystemPromptBytes) throw new Error();
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  } catch { throw new ConfigurationError('pi-config/SYSTEM.md 必须是配置目录内的 UTF-8 文件，且不超过 64 KiB'); }
  return validateSystemPrompt({ mode: 'replace', text });
}
