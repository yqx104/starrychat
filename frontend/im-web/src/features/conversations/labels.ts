import type { Conversation, Participant } from '../../api/types';

export function conversationName(conversation: Conversation, members?: Participant[]): string {
  if (conversation.title?.trim()) return conversation.title;
  if (conversation.kind === 'direct') return members?.find((member) => member.kind === 'agent')?.name || `单聊 #${conversation.conversation_id}`;
  return `群聊 #${conversation.conversation_id}`;
}
export function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp));
}
export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(timestamp));
}
