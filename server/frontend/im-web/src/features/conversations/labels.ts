import type { Conversation, Participant } from '../../api/types';

export function conversationName(conversation: Conversation, members?: Participant[]): string {
  if (conversation.title?.trim()) return conversation.title;
  if (conversation.kind === 'direct')
    return (
      members?.find((member) => member.kind === 'agent')?.name ||
      `单聊 #${conversation.conversation_id}`
    );
  return `群聊 #${conversation.conversation_id}`;
}
