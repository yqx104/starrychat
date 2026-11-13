export type ParticipantKind = 'human' | 'agent';

export interface Participant {
  participant_id: string;
  kind: ParticipantKind;
  name: string;
  created_at: number;
}

export interface AgentAccount {
  participant_id: string;
  kind: 'agent';
  name: string;
  username: string;
  owner_participant_id: string;
  created_at: number;
}

export interface CreateAgentInput { name: string; username: string; password: string }
export interface UpdateAgentInput { name?: string; username?: string; password?: string }

export interface Conversation {
  conversation_id: string;
  kind: 'direct' | 'group';
  title: string | null;
  created_at: number;
  dissolved_at: number | null;
  hidden: boolean;
}

export interface Message {
  message_seq: number;
  message_id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: number;
  mentioned_agent_ids: string[];
  quoted_message_id: string | null;
}

export interface MessagePage { messages: Message[]; has_more: boolean }
export type MessageQuery = { limit?: number; before_seq?: number; after_seq?: never }
  | { limit?: number; after_seq?: number; before_seq?: never };
export interface SendMessageInput { content: string; mentioned_agent_ids?: string[]; quoted_message_id?: string }
