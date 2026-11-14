import type { InboxRow, Message } from '../model/types.ts';

// Stable envelope supplies both provenance and an exact identity for recovery checks.
export function formatInput(row: InboxRow): string {
  const message = JSON.parse(row.message_json) as Message;
  return `IM 输入\n${JSON.stringify({ adaptor_input_id: row.id, agent_id: row.agent_id, channel_id: row.channel_id, message })}`;
}
