import type { Disposition } from '@starrychat/pi-adaptor';

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
export type InputState = 'pending' | 'sending' | 'accepted' | 'rejected' | 'needs_recovery';
export interface InboxRow {
  id: number; agent_id: string; channel_id: string; message_json: string;
  state: InputState; receipt_disposition: Disposition | null; last_error: string | null;
}
export interface SessionRecord {
  session_id: string; agent_id: string; harness: 'pi'; cwd: string;
  config_json: string; native_ref_json: string | null;
}
