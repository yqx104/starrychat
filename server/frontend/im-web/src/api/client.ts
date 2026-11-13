import { apiBaseUrl } from './config';
import type { AgentAccount, Conversation, CreateAgentInput, Message, MessagePage, MessageQuery, Participant, SendMessageInput, UpdateAgentInput } from './types';

export class ApiError extends Error {
  constructor(message: string, public code: string, public status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function invalid(): never { throw new ApiError('服务返回的数据格式不正确，请稍后重试。', 'INVALID_RESPONSE'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function id(value: unknown): string {
  if (typeof value !== 'string' || !uuidV7.test(value)) return invalid();
  return value;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8.64e15) return invalid();
  return value;
}
function string(value: unknown): string { return typeof value === 'string' ? value : invalid(); }
function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) return invalid();
  return value.map(parse);
}
function participant(value: unknown): Participant {
  const p = object(value);
  if (p.kind !== 'human' && p.kind !== 'agent') return invalid();
  return { participant_id: id(p.participant_id), kind: p.kind, name: string(p.name), created_at: timestamp(p.created_at) };
}
function agentAccount(value: unknown): AgentAccount {
  const a = object(value);
  if (a.kind !== 'agent') return invalid();
  return { participant_id: id(a.participant_id), kind: 'agent', name: string(a.name), username: string(a.username), owner_participant_id: id(a.owner_participant_id), created_at: timestamp(a.created_at) };
}
function conversation(value: unknown): Conversation {
  const c = object(value);
  if ((c.kind !== 'direct' && c.kind !== 'group') || typeof c.hidden !== 'boolean') return invalid();
  return { conversation_id: id(c.conversation_id), kind: c.kind, title: c.title === null ? null : string(c.title), created_at: timestamp(c.created_at), dissolved_at: c.dissolved_at === null ? null : timestamp(c.dissolved_at), hidden: c.hidden };
}
function message(value: unknown): Message {
  const m = object(value);
  return { message_seq: sequence(m.message_seq), message_id: id(m.message_id), conversation_id: id(m.conversation_id), sender_id: id(m.sender_id), content: string(m.content), created_at: timestamp(m.created_at), mentioned_agent_ids: array(m.mentioned_agent_ids, id), quoted_message_id: m.quoted_message_id === null ? null : id(m.quoted_message_id) };
}
function page(value: unknown): MessagePage {
  const p = object(value);
  if (typeof p.has_more !== 'boolean') return invalid();
  return { messages: array(p.messages, message), has_more: p.has_more };
}
function validId(value: string): void {
  if (typeof value !== 'string' || !uuidV7.test(value)) throw new ApiError('ID 必须是标准 UUIDv7 字符串。', 'INVALID_REQUEST');
}
function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return invalid();
  return value;
}
function validSeq(value: number, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new ApiError('消息序号超出有效范围。', 'INVALID_REQUEST');
}

export class ImApi {
  private sessionEnabled = true;
  private sessionGeneration = 0;
  private requests = new Map<AbortController, Promise<unknown>>();
  private draining: Promise<void> = Promise.resolve();
  private unauthorized: (() => void) | null = null;

  constructor(private base = apiBaseUrl, private fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  onUnauthorized(listener: () => void): () => void {
    this.unauthorized = listener;
    return () => { if (this.unauthorized === listener) this.unauthorized = null; };
  }
  suspendSession(): Promise<void> {
    this.sessionEnabled = false;
    this.sessionGeneration += 1;
    const pending = [...this.requests.values()];
    this.requests.forEach((_promise, controller) => controller.abort());
    this.draining = Promise.allSettled([this.draining, ...pending]).then(() => undefined);
    return this.draining;
  }
  waitForDrain(): Promise<void> { return this.draining; }
  resumeSession(): void { this.sessionEnabled = true; }

  private async request(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
    const sessionRequest = !path.startsWith('/auth/');
    const generation = this.sessionGeneration;
    if (sessionRequest && !this.sessionEnabled) throw new DOMException('会话请求已暂停。', 'AbortError');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const operation = this.performRequest(path, { ...options, signal: controller.signal });
    if (sessionRequest) this.requests.set(controller, operation);
    try {
      const payload = await operation;
      if (controller.signal.aborted || (sessionRequest && generation !== this.sessionGeneration)) throw new DOMException('请求已取消。', 'AbortError');
      return payload;
    } catch (error) {
      if (controller.signal.aborted || (sessionRequest && generation !== this.sessionGeneration)) throw new DOMException('请求已取消。', 'AbortError');
      if (sessionRequest && error instanceof ApiError && error.status === 401 && this.sessionEnabled) {
        void this.suspendSession();
        this.unauthorized?.();
      }
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (sessionRequest) this.requests.delete(controller);
    }
  }

  private async performRequest(path: string, options: { method?: string; body?: unknown; signal: AbortSignal }): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method: options.method ?? 'GET',
        signal: options.signal,
        credentials: 'same-origin',
        ...(options.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new ApiError('无法连接 IM 服务，请检查服务地址或网络后重试。', 'NETWORK_ERROR');
    }
    if (response.status === 204 && response.ok) return null;
    let payload: unknown;
    try { payload = await response.json(); } catch {
      if (!response.ok) throw new ApiError(`无法连接 IM 服务或服务返回错误（HTTP ${response.status}），请检查服务地址后重试。`, 'HTTP_ERROR', response.status);
      throw new ApiError('服务返回的数据格式不正确，请稍后重试。', 'INVALID_RESPONSE', response.status);
    }
    if (!response.ok) {
      const detail = (payload && typeof payload === 'object' && 'error' in payload) ? (payload as { error: unknown }).error : null;
      if (detail && typeof detail === 'object' && 'code' in detail && 'message' in detail && typeof detail.code === 'string' && typeof detail.message === 'string') {
        throw new ApiError(detail.message, detail.code, response.status);
      }
      throw new ApiError(`请求失败（HTTP ${response.status}），请稍后重试。`, 'HTTP_ERROR', response.status);
    }
    return payload;
  }

  async register(username: string, password: string, name: string): Promise<Participant> {
    const result = object(await this.request('/auth/register', { method: 'POST', body: { username, password, name, kind: 'human' } }));
    return participant(result.participant);
  }
  async login(username: string, password: string): Promise<{ participant: Participant; expires_at: number }> {
    const result = object(await this.request('/auth/login', { method: 'POST', body: { username, password, transport: 'cookie' } }));
    return { participant: participant(result.participant), expires_at: timestamp(result.expires_at) };
  }
  async me(signal?: AbortSignal): Promise<Participant> {
    return participant(object(await this.request('/auth/me', { signal })).participant);
  }
  async logout(): Promise<void> { await this.request('/auth/logout', { method: 'POST' }); }

  async agents(signal?: AbortSignal): Promise<AgentAccount[]> {
    return array(object(await this.request('/agents', { signal })).agents, agentAccount);
  }
  async createAgent(input: CreateAgentInput): Promise<AgentAccount> {
    const { name, username, password } = input;
    return agentAccount(object(await this.request('/agents', { method: 'POST', body: { name, username, password } })).agent);
  }
  async updateAgent(participantId: string, input: UpdateAgentInput): Promise<AgentAccount> {
    validId(participantId);
    const body = { ...(input.name === undefined ? {} : { name: input.name }), ...(input.username === undefined ? {} : { username: input.username }), ...(input.password === undefined ? {} : { password: input.password }) };
    if (!Object.keys(body).length) throw new ApiError('请选择要修改的资料。', 'INVALID_REQUEST');
    const agent = agentAccount(object(await this.request(`/agents/${participantId}`, { method: 'PATCH', body })).agent);
    if (agent.participant_id !== participantId) return invalid();
    return agent;
  }

  async participants(signal?: AbortSignal): Promise<Participant[]> {
    return array(object(await this.request('/participants', { signal })).participants, participant);
  }
  async conversations(signal?: AbortSignal): Promise<Conversation[]> {
    return array(object(await this.request('/conversations', { signal })).conversations, conversation);
  }
  async getConversation(conversationId: string, signal?: AbortSignal): Promise<Conversation> {
    validId(conversationId);
    return conversation(object(await this.request(`/conversations/${conversationId}`, { signal })).conversation);
  }
  async createGroup(title: string, agentIds: string[]): Promise<Conversation> {
    agentIds.forEach(validId);
    return conversation(object(await this.request('/conversations', { method: 'POST', body: { title, agent_ids: agentIds } })).conversation);
  }
  async openDirect(agentId: string): Promise<Conversation> {
    validId(agentId);
    return conversation(object(await this.request('/conversations/direct', { method: 'POST', body: { agent_id: agentId } })).conversation);
  }
  async setVisibility(conversationId: string, hidden: boolean): Promise<Conversation> {
    validId(conversationId);
    const result = conversation(object(await this.request(`/conversations/${conversationId}/visibility`, { method: 'PATCH', body: { hidden } })).conversation);
    if (result.conversation_id !== conversationId || result.hidden !== hidden) return invalid();
    return result;
  }
  async rename(conversationId: string, title: string): Promise<Conversation> {
    validId(conversationId);
    return conversation(object(await this.request(`/conversations/${conversationId}`, { method: 'PATCH', body: { title } })).conversation);
  }
  async dissolve(conversationId: string): Promise<Conversation> {
    validId(conversationId);
    return conversation(object(await this.request(`/conversations/${conversationId}/dissolve`, { method: 'POST', body: {} })).conversation);
  }
  async members(conversationId: string, signal?: AbortSignal): Promise<Participant[]> {
    validId(conversationId);
    return array(object(await this.request(`/conversations/${conversationId}/members`, { signal })).members, participant);
  }
  async addMember(conversationId: string, participantId: string): Promise<Participant> {
    validId(conversationId); validId(participantId);
    return participant(object(await this.request(`/conversations/${conversationId}/members`, { method: 'POST', body: { participant_id: participantId } })).member);
  }
  async removeMember(conversationId: string, participantId: string): Promise<void> {
    validId(conversationId); validId(participantId);
    await this.request(`/conversations/${conversationId}/members/${participantId}`, { method: 'DELETE' });
  }
  async messages(conversationId: string, query: MessageQuery = {}, signal?: AbortSignal): Promise<MessagePage> {
    validId(conversationId);
    if (query.before_seq !== undefined && query.after_seq !== undefined) throw new ApiError('不能同时指定两个分页方向。', 'INVALID_REQUEST');
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50)) throw new ApiError('消息数量必须在 1 到 50 之间。', 'INVALID_REQUEST');
    if (query.before_seq !== undefined) validSeq(query.before_seq);
    if (query.after_seq !== undefined) validSeq(query.after_seq, true);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    const result = page(await this.request(`/conversations/${conversationId}/messages${params.size ? `?${params}` : ''}`, { signal }));
    if (result.has_more && !result.messages.length) return invalid();
    if (new Set(result.messages.map((item) => item.message_id)).size !== result.messages.length) return invalid();
    if (result.messages.some((item, index) => item.conversation_id !== conversationId || (index > 0 && item.message_seq <= result.messages[index - 1].message_seq) || (query.before_seq !== undefined && item.message_seq >= query.before_seq) || (query.after_seq !== undefined && item.message_seq <= query.after_seq))) return invalid();
    return result;
  }
  async send(conversationId: string, input: SendMessageInput): Promise<Message> {
    validId(conversationId); input.mentioned_agent_ids?.forEach(validId);
    if (input.quoted_message_id !== undefined) validId(input.quoted_message_id);
    const result = message(object(await this.request(`/conversations/${conversationId}/messages`, { method: 'POST', body: input })).message);
    if (result.conversation_id !== conversationId) return invalid();
    return result;
  }
}

export const api = new ImApi();
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '出现未知错误，请重试。';
}
