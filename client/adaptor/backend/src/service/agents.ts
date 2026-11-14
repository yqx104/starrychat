import type { Agent } from '../model/types.ts';
import type { Config } from '../config/config.ts';
import { APIError } from '../model/errors.ts';
import { login } from '../clients/im.ts';
import { Store } from '../repository/store.ts';
import { Connections } from './connections.ts';
import { Sessions } from './sessions.ts';

export class Agents {
  private store: Store;
  private config: Config;
  private connections: Connections;
  private sessions: Sessions;

  constructor(store: Store, config: Config, connections: Connections, sessions: Sessions) {
    this.store = store; this.config = config; this.connections = connections; this.sessions = sessions;
  }

  require(id: string) {
    const agent = this.store.agent(id);
    if (!agent) throw new APIError(404, 'NOT_FOUND', 'Agent 不存在');
    return agent;
  }

  view(id: string) {
    return { ...publicAgent(this.require(id)), ...this.connections.status(id), session_status: this.sessions.view(id).status };
  }

  list() { return this.store.agents().map(agent => this.view(agent.agent_id)); }

  async connect(username: string, password: string, id?: string) {
    if (id) this.require(id);
    const account = await login(this.config.im_base_url, username, password);
    if (id) {
      if (account.agent_id !== id) throw new APIError(409, 'IDENTITY_MISMATCH', '必须使用同一个 Agent 账号');
      this.store.credentials(id, account.token, account.expires_at, account.name, account.username);
    } else {
      if (this.store.agent(account.agent_id)) throw new APIError(409, 'ALREADY_EXISTS', '该 Agent 已接入');
      this.store.add(account);
    }
    this.connections.restart(account.agent_id);
    if (!id) void this.sessions.reconcile(account.agent_id);
    return this.view(account.agent_id);
  }

  enable(id: string, enabled: boolean) {
    this.require(id);
    this.store.enable(id, enabled); this.connections.restart(id);
    void this.sessions.reconcile(id);
    return this.view(id);
  }

  inbox(id: string, before: number, limit: number) { this.require(id); return this.store.inbox(id, before, limit); }
}

export function publicAgent(agent: Agent) {
  const { token: _token, ...publicFields } = agent;
  return { ...publicFields, enabled: Boolean(agent.enabled) };
}
