import type { Config } from '../config/config.ts';
import { Store } from '../repository/store.ts';
import { TriggerClient } from '../clients/trigger.ts';

export class Connections {
  private store: Store;
  private config: Config;
  private clients = new Map<string, TriggerClient>();
  private closed = false;
  private onReceipt: (agentId: string) => void;

  constructor(store: Store, config: Config, onReceipt: (agentId: string) => void = () => {}) {
    this.store = store; this.config = config; this.onReceipt = onReceipt;
  }

  startAll() { for (const agent of this.store.agents()) if (agent.enabled) this.start(agent.agent_id); }
  status(id: string) {
    return this.clients.get(id)?.status() ?? { connection_state: 'disabled', connected_at: null, last_error: null };
  }

  restart(id: string) { this.stop(id); if (this.store.agent(id)?.enabled) this.start(id); }

  start(id: string) {
    if (this.closed) return;
    this.stop(id);
    const client = new TriggerClient({
      url: this.config.trigger_ws_url, adaptorId: this.config.adaptor_id, agentId: id,
      credentials: () => {
        const agent = this.store.agent(id)!;
        return { token: agent.token, expires_at: agent.credential_expires_at };
      },
      onReady: credentials => this.store.credentials(id, credentials.token, credentials.expires_at),
      onDelivery: delivery => {
        const inserted = this.store.receive(delivery);
        client.ack(delivery.message.message_id);
        if (inserted) queueMicrotask(() => {
          // Dispatch is outside the receipt/ACK failure boundary; SQLite is the source of truth.
          try { if (!this.closed) this.onReceipt(id); } catch { console.error('输入派发唤醒失败，等待后台补扫'); }
        });
      },
    });
    this.clients.set(id, client);
    client.start();
  }

  stop(id: string) {
    const client = this.clients.get(id);
    this.clients.delete(id);
    client?.close();
  }

  close() { this.closed = true; for (const id of this.clients.keys()) this.stop(id); }
}
