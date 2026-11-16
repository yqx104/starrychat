import { existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NativeRef } from '../model/types.ts';

function header(path: string): { type: string; id: string } {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(16384);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    return JSON.parse(buffer.subarray(0, size).toString().split('\n')[0]);
  } finally { closeSync(fd); }
}

export function locateSessionFile(ref: NativeRef, sessionDir: string, allowCreate: boolean): string | null {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  if (ref.session_file) {
    if (!existsSync(ref.session_file)) throw new Error('原 Pi 会话文件缺失；请恢复文件，不能创建空上下文');
    const value = header(ref.session_file);
    if (value.type !== 'session' || value.id !== ref.session_id) throw new Error('Pi 会话文件身份不匹配');
    return ref.session_file;
  }
  const matches = readdirSync(sessionDir).filter(name => name.endsWith('.jsonl')).filter(name => {
    const value = header(join(sessionDir, name));
    return value.type === 'session' && value.id === ref.session_id;
  });
  if (matches.length > 1) throw new Error('找到多个同 ID 的 Pi 会话文件，请先核对');
  if (matches.length === 1) return join(sessionDir, matches[0]);
  if (!allowCreate) throw new Error('已有输入可能被处理，但无法确认 Pi 历史；请先核对待恢复输入');
  return ref.session_file;
}

export function validateSessionFile(ref: NativeRef, sessionFile: string | undefined): string | null {
  if (ref.session_file && !existsSync(ref.session_file)) throw new Error('原 Pi 会话文件缺失，已停止派发');
  if (sessionFile && existsSync(sessionFile)) {
    const file = resolve(sessionFile);
    if (ref.session_file && file !== resolve(ref.session_file)) throw new Error('Pi 会话文件路径发生变化，已停止派发');
    if (header(file).id !== ref.session_id) throw new Error('Pi 持久化文件身份不匹配');
    return file;
  }
  return ref.session_file;
}

export async function readPersistedInputs(sessionFile: string | null): Promise<Set<string>> {
  if (!sessionFile) return new Set();
  const { parseSessionEntries } = await import('@earendil-works/pi-coding-agent');
  const entries = parseSessionEntries(readFileSync(sessionFile, 'utf8'));
  const texts = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message.role !== 'user') continue;
    const content = entry.message.content;
    texts.add(typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join(''));
  }
  return texts;
}
