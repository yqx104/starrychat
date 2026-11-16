import WebSocket from 'ws';
import type { Delivery } from '../model/types.ts';

interface Credentials { token: string; expires_at: number }
interface TriggerOptions {
  url: string;
  adaptorId: string;
  agentId: string;
  credentials: () => Credentials;
  onReady: (credentials: Credentials) => void;
  onDelivery: (delivery: Delivery) => void;
}

// One Agent connection. Persistence and the decision to ACK belong to the caller.
export class TriggerClient {
  private options: TriggerOptions;
  private socket?: WebSocket;
  private retry?: NodeJS.Timeout;
  private refresh?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private closed = false;
  private state = 'connecting';
  private lastError: string | null = null;
  private connectedAt: number | null = null;

  constructor(options: TriggerOptions) { this.options = options; }

  status() {
    return { connection_state: this.state, connected_at: this.connectedAt, last_error: this.lastError };
  }

  start() {
    if (this.closed) return;
    const credentials = this.options.credentials();
    if (credentials.expires_at <= Date.now()) {
      this.state = 'auth_required'; this.lastError = '凭据已过期，请重新认证'; return;
    }
    this.state = 'connecting';
    const ws = new WebSocket(this.options.url, {
      headers: { Authorization: `Bearer ${credentials.token}`, 'X-Adaptor-ID': this.options.adaptorId },
      handshakeTimeout: 5000, maxPayload: 1024 * 1024,
    });
    this.socket = ws;
    const current = () => !this.closed && this.socket === ws;
    const alive = () => {
      if (!current()) return;
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => { this.lastError = '连接心跳超时'; ws.terminate(); }, 45000);
    };
    ws.on('open', alive);
    ws.on('ping', alive);
    ws.on('message', data => {
      if (!current()) return;
      alive();
      try {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'ready') {
          if (frame.agent_id !== this.options.agentId || typeof frame.token !== 'string' || !Number.isSafeInteger(frame.expires_at)) throw new Error('Invalid identity');
          this.options.onReady({ token: frame.token, expires_at: frame.expires_at });
          this.state = 'online'; this.lastError = null; this.connectedAt = Date.now();
          // Reconnect before expiry; the next IM identity check renews the token.
          this.refresh = setTimeout(() => ws.close(), Math.max(1000, frame.expires_at - Date.now() - 60000));
        } else if (frame.type === 'delivery') {
          const delivery = frame as Delivery;
          if (this.state !== 'online' || delivery.agent_id !== this.options.agentId || !delivery.message?.message_id) throw new Error('Invalid delivery');
          this.options.onDelivery(delivery);
        }
      } catch {
        this.lastError = '消息未能保存，等待重新投递';
        ws.terminate();
      }
    });
    ws.on('unexpected-response', (_request, response) => {
      if (!current()) { response.resume(); ws.terminate(); return; }
      if (response.statusCode === 401 || response.statusCode === 403) {
        this.state = 'auth_required'; this.lastError = '身份验证失败，请重新认证';
      } else if (response.statusCode === 409) {
        this.state = 'conflict'; this.lastError = '该 Agent 已有连接';
      } else { this.lastError = 'Trigger 暂时不可用'; }
      response.resume(); ws.terminate();
    });
    ws.on('error', () => { if (current()) this.lastError ??= '无法连接 Trigger'; });
    ws.on('close', code => {
      if (!current()) return;
      clearTimeout(this.watchdog); clearTimeout(this.refresh);
      this.connectedAt = null;
      if (code === 4001) { this.state = 'auth_required'; this.lastError = '凭据已过期，请重新认证'; }
      if (this.state === 'auth_required') return;
      if (this.state !== 'conflict') this.state = 'reconnecting';
      this.retry = setTimeout(() => this.start(), 2000);
    });
  }

  ack(messageId: string) {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Trigger connection is not open');
    this.socket.send(JSON.stringify({ type: 'ack', message_id: messageId }));
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry); clearTimeout(this.refresh); clearTimeout(this.watchdog);
    this.socket?.terminate();
  }
}
