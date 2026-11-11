import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export interface Agent {
  agent_id: string;
  name: string;
  username: string;
  token: string;
  credential_expires_at: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface Message {
  message_id: string;
  channel_type: 'im_direct' | 'im_group';
  conversation_id: string;
  message_seq: number;
  sender_id: string;
  sender_kind: string;
  content: string;
  mentioned_agent_ids: string[];
  quoted_message_id: string | null;
  created_at: number;
}

export interface Delivery { agent_id: string; channel_id: string; message: Message }

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (!existsSync(path)) throw new Error('SQLite 尚未初始化，请显式执行 db:init');
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON');
    // Startup only checks the current schema; it never creates or alters tables.
    this.db.prepare('SELECT agent_id,name,username,token,credential_expires_at,enabled,created_at,updated_at FROM agents LIMIT 0').all();
    this.db.prepare('SELECT id,agent_id,message_id,channel_id,message_json,state,received_at FROM inbox LIMIT 0').all();
  }

  agents(): Agent[] { return this.db.prepare('SELECT * FROM agents ORDER BY created_at,agent_id').all() as unknown as Agent[]; }
  agent(id: string): Agent | undefined { return this.db.prepare('SELECT * FROM agents WHERE agent_id=?').get(id) as unknown as Agent | undefined; }

  add(input: { agent_id: string; name: string; username: string; token: string; expires_at: number }) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO agents (agent_id,name,username,token,credential_expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(input.agent_id, input.name, input.username, input.token, input.expires_at, now, now);
  }

  credentials(id: string, token: string, expiresAt: number, name?: string, username?: string) {
    this.db.prepare(`UPDATE agents SET token=?,credential_expires_at=?,name=COALESCE(?,name),
      username=COALESCE(?,username),updated_at=? WHERE agent_id=?`)
      .run(token, expiresAt, name ?? null, username ?? null, Date.now(), id);
  }

  enable(id: string, enabled: boolean) {
    this.db.prepare('UPDATE agents SET enabled=?,updated_at=? WHERE agent_id=?').run(Number(enabled), Date.now(), id);
  }

  receive(item: Delivery) {
    // This synchronous statement commits before the caller is allowed to ACK.
    this.db.prepare(`INSERT INTO inbox (agent_id,message_id,channel_id,message_json,received_at)
      VALUES (?,?,?,?,?) ON CONFLICT(agent_id,message_id) DO NOTHING`)
      .run(item.agent_id, item.message.message_id, item.channel_id, JSON.stringify(item.message), Date.now());
  }

  inbox(id: string, before: number, limit: number) {
    const rows = this.db.prepare(`SELECT id,agent_id,channel_id,message_json,state,received_at FROM inbox
      WHERE agent_id=? AND id<? ORDER BY id DESC LIMIT ?`).all(id, before, limit + 1);
    return {
      messages: rows.slice(0, limit).map(({ message_json, ...row }) => ({ ...row, message: JSON.parse(String(message_json)) })),
      has_more: rows.length > limit,
    };
  }

  close() { this.db.close(); }
}

export function publicAgent(agent: Agent) {
  const { token: _token, ...publicFields } = agent;
  return { ...publicFields, enabled: Boolean(agent.enabled) };
}
