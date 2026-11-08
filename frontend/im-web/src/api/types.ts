export type ParticipantKind = 'human' | 'agent';

export interface Participant {
  participant_id: number;
  kind: ParticipantKind;
  name: string;
  created_at: number;
}

export interface AgentAccount {
  participant_id: number;
  kind: 'agent';
  name: string;
  username: string;
  owner_participant_id: number;
  created_at: number;
}

export interface CreateAgentInput { name: string; username: string; password: string }
export interface UpdateAgentInput { name?: string; username?: string; password?: string }

export interface Conversation {
  conversation_id: number;
  kind: 'direct' | 'group';
  title: string | null;
  created_at: number;
  dissolved_at: number | null;
}

export interface Message {
  message_id: number;
  conversation_id: number;
  sender_id: number;
  content: string;
  created_at: number;
  mentioned_agent_ids: number[];
  quoted_message_id: number | null;
}

export interface MessagePage { messages: Message[]; has_more: boolean }
export type MessageQuery = { limit?: number; before_message_id?: number; after_message_id?: never }
  | { limit?: number; after_message_id?: number; before_message_id?: never };
export interface SendMessageInput { content: string; mentioned_agent_ids?: number[]; quoted_message_id?: number }
