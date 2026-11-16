import type { IncomingMessage, ServerResponse } from 'node:http';
import { APIError } from '../model/errors.ts';

export async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new APIError(400, 'INVALID_REQUEST', '请求需要 JSON');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new APIError(413, 'INVALID_REQUEST', '请求过大');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new APIError(400, 'INVALID_REQUEST', '无效的 JSON'); }
}

export function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
  return true;
}
