import { APIError } from '../model/errors.ts';
import { z } from 'zod';

export const imId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const timestamp = z.number().int().nonnegative();
const participant = z.object({ participant_id: imId, kind: z.enum(['human', 'agent']), name: z.string(), created_at: timestamp });
const conversation = z.object({ conversation_id: imId, kind: z.enum(['direct', 'group']), title: z.string().nullable(),
  created_at: timestamp, dissolved_at: timestamp.nullable(), hidden: z.boolean() });
const message = z.object({ message_id: imId, conversation_id: imId, message_seq: z.number().int().positive(),
  sender_id: imId, content: z.string(), mentioned_agent_ids: z.array(imId), quoted_message_id: imId.nullable(), created_at: timestamp });

export interface MessageQuery { limit?: number; before_seq?: number; after_seq?: number }
export interface SendMessage { content: string; quoted_message_id?: string; mentioned_agent_ids?: string[] }

export class ImClient {
  private base: string;
  private credentials: () => { token: string; expires_at: number };
  private renewed: (previousToken: string, token: string, expiresAt: number) => void;

  constructor(base: string, credentials: () => { token: string; expires_at: number },
    renewed: (previousToken: string, token: string, expiresAt: number) => void) {
    this.base = base; this.credentials = credentials; this.renewed = renewed;
  }

  private async request<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal, input?: SendMessage): Promise<T> {
    const credentials = this.credentials();
    if (credentials.expires_at <= Date.now()) throw new APIError(401, 'IM_AUTH_REQUIRED', 'IM 登录已过期，请在 adaptor 重新认证');
    const uncertain = () => new APIError(502, 'SEND_RESULT_UNKNOWN', '发送结果未知，消息可能已保存。请查询会话历史核实，不要自动重发');
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method: input ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${credentials.token}`, ...(input ? { 'Content-Type': 'application/json' } : {}) },
        body: input ? JSON.stringify(input) : undefined,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      });
    } catch { throw input ? uncertain() : new APIError(502, 'IM_UNAVAILABLE', '无法连接 IM 服务'); }
    const token = response.headers.get('X-IM-Token');
    const expiresAt = Number(response.headers.get('X-IM-Token-Expires-At'));
    if (token && Number.isSafeInteger(expiresAt) && expiresAt > Date.now()) this.renewed(credentials.token, token, expiresAt);
    if (response.status === 401) throw new APIError(401, 'IM_AUTH_REQUIRED', 'IM 登录已失效，请在 adaptor 重新认证');
    if (input && response.status >= 500) throw uncertain();
    let payload: unknown;
    try { payload = await response.json(); }
    catch { throw input ? uncertain() : new APIError(502, 'IM_INVALID_RESPONSE', 'IM 返回了无效响应'); }
    if (!response.ok) {
      const error = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).safeParse(payload);
      throw new APIError(response.status, error.success ? error.data.error.code : 'IM_REQUEST_FAILED',
        error.success ? error.data.error.message : `IM 请求失败（HTTP ${response.status}）`);
    }
    const result = schema.safeParse(payload);
    if (!result.success) throw input ? uncertain() : new APIError(502, 'IM_INVALID_RESPONSE', 'IM 返回的数据格式不正确');
    return result.data;
  }

  whoami(signal?: AbortSignal) { return this.request('/auth/me', z.object({ participant }), signal); }
  listConversations(signal?: AbortSignal) { return this.request('/conversations', z.object({ conversations: z.array(conversation) }), signal); }
  listParticipants(kind?: 'human' | 'agent', signal?: AbortSignal) {
    return this.request(`/participants${kind ? `?kind=${kind}` : ''}`, z.object({ participants: z.array(participant) }), signal);
  }
  async getConversation(id: string, signal?: AbortSignal) {
    const [details, members] = await Promise.all([
      this.request(`/conversations/${id}`, z.object({ conversation }), signal),
      this.request(`/conversations/${id}/members`, z.object({ members: z.array(participant) }), signal),
    ]);
    return { ...details, ...members };
  }
  listMessages(id: string, query: MessageQuery, signal?: AbortSignal) {
    if (query.before_seq !== undefined && query.after_seq !== undefined) throw new APIError(400, 'INVALID_REQUEST', 'before_seq 与 after_seq 不能同时使用');
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    return this.request(`/conversations/${id}/messages?${params}`, z.object({ messages: z.array(message), has_more: z.boolean() }), signal);
  }
  sendMessage(id: string, input: SendMessage, signal?: AbortSignal) {
    return this.request(`/conversations/${id}/messages`, z.object({ message }), signal, input);
  }
}

export async function login(base: string, username: string, password: string) {
  let response: Response;
  try {
    response = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, transport: 'bearer' }),
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
  } catch { throw new APIError(502, 'IM_UNAVAILABLE', '无法连接 IM 服务'); }
  if (!response.ok) throw new APIError(response.status === 401 ? 401 : 502, 'IM_LOGIN_FAILED', 'IM 登录失败，请检查账号和密码');
  const body = await response.json() as {
    participant: { participant_id: string; kind: string; name: string }; token: string; expires_at: number;
  };
  if (body.participant.kind !== 'agent') throw new APIError(400, 'AGENT_REQUIRED', '请使用 IM 中的 Agent 账号');
  return { agent_id: body.participant.participant_id, name: body.participant.name, username, token: body.token, expires_at: body.expires_at };
}
