import WebSocket from 'ws';
import type { Config } from './config.ts';
import { Store, type Delivery } from './store.ts';

interface Runtime {
  state: string;
  last_error: string | null;
  connected_at: number | null;
  socket?: WebSocket;
  retry?: NodeJS.Timeout;
  refresh?: NodeJS.Timeout;
  watchdog?: NodeJS.Timeout;
}

export class Connections {
  store: Store;
  config: Config;
  runtimes = new Map<string, Runtime>();
  closed = false;

  constructor(store: Store, config: Config) { this.store = store; this.config = config; }

  startAll() { for (const agent of this.store.agents()) if (agent.enabled) this.start(agent.agent_id); }
  status(id: string) {
    const runtime = this.runtimes.get(id);
    return { connection_state: runtime?.state ?? 'disabled', connected_at: runtime?.connected_at ?? null, last_error: runtime?.last_error ?? null };
  }

  restart(id: string) { this.stop(id); if (this.store.agent(id)?.enabled) this.start(id); }

  start(id: string) {
    if (this.closed) return;
    const runtime: Runtime = { state: 'connecting', last_error: null, connected_at: null };
    this.runtimes.set(id, runtime);
    const connect = () => {
      if (this.runtimes.get(id) !== runtime) return;
      const agent = this.store.agent(id)!;
      if (agent.credential_expires_at <= Date.now()) {
        runtime.state = 'auth_required'; runtime.last_error = '凭据已过期，请重新认证'; return;
      }
      runtime.state = 'connecting';
      const ws = new WebSocket(this.config.trigger_ws_url, {
        headers: { Authorization: `Bearer ${agent.token}`, 'X-Adaptor-ID': this.config.adaptor_id },
        handshakeTimeout: 5000, maxPayload: 1024 * 1024,
      });
      runtime.socket = ws;
      const alive = () => {
        clearTimeout(runtime.watchdog);
        runtime.watchdog = setTimeout(() => { runtime.last_error = '连接心跳超时'; ws.terminate(); }, 45000);
      };
      ws.on('open', alive);
      ws.on('ping', alive);
      ws.on('message', data => {
        if (this.runtimes.get(id) !== runtime) return;
        alive();
        try {
          const frame = JSON.parse(data.toString());
          if (frame.type === 'ready') {
            if (frame.agent_id !== id || typeof frame.token !== 'string' || !Number.isSafeInteger(frame.expires_at)) throw new Error('Invalid identity');
            this.store.credentials(id, frame.token, frame.expires_at);
            runtime.state = 'online'; runtime.last_error = null; runtime.connected_at = Date.now();
            // Reconnect before expiry; the next IM identity check renews the token.
            runtime.refresh = setTimeout(() => ws.close(), Math.max(1000, frame.expires_at - Date.now() - 60000));
          } else if (frame.type === 'delivery') {
            const delivery = frame as Delivery;
            if (runtime.state !== 'online' || delivery.agent_id !== id || !delivery.message?.message_id) throw new Error('Invalid delivery');
            this.store.receive(delivery);
            ws.send(JSON.stringify({ type: 'ack', message_id: delivery.message.message_id }));
          }
        } catch {
          runtime.last_error = '消息未能保存，等待重新投递';
          ws.terminate();
        }
      });
      ws.on('unexpected-response', (_request, response) => {
        if (response.statusCode === 401 || response.statusCode === 403) {
          runtime.state = 'auth_required'; runtime.last_error = '身份验证失败，请重新认证';
        } else if (response.statusCode === 409) {
          runtime.state = 'conflict'; runtime.last_error = '该 Agent 已有连接';
        } else { runtime.last_error = 'Trigger 暂时不可用'; }
        response.resume(); ws.terminate();
      });
      ws.on('error', () => { runtime.last_error ??= '无法连接 Trigger'; });
      ws.on('close', code => {
        clearTimeout(runtime.watchdog); clearTimeout(runtime.refresh);
        if (this.runtimes.get(id) !== runtime) return;
        runtime.connected_at = null;
        if (code === 4001) { runtime.state = 'auth_required'; runtime.last_error = '凭据已过期，请重新认证'; }
        if (runtime.state === 'auth_required') return;
        if (runtime.state !== 'conflict') runtime.state = 'reconnecting';
        runtime.retry = setTimeout(connect, 2000);
      });
    };
    connect();
  }

  stop(id: string) {
    const runtime = this.runtimes.get(id);
    this.runtimes.delete(id);
    if (!runtime) return;
    clearTimeout(runtime.retry); clearTimeout(runtime.refresh); clearTimeout(runtime.watchdog);
    runtime.socket?.terminate();
  }

  close() { this.closed = true; for (const id of this.runtimes.keys()) this.stop(id); }
}
