import type { SessionEvent } from './types.ts';

const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 16000) : '';

// Deliberately expose display fields, never raw RPC responses, model headers or extension payloads.
export function displayEvent(event: any): SessionEvent | undefined {
  switch (event.type) {
    case 'message_update':
      if (event.assistantMessageEvent?.type === 'text_delta') return { type: 'text', text: text(event.assistantMessageEvent.delta) };
      break;
    case 'message_end':
      if (event.message?.role === 'assistant' && event.message.errorMessage) return { type: 'error', text: text(event.message.errorMessage) };
      break;
    case 'tool_execution_start': case 'tool_execution_update': case 'tool_execution_end':
      return { type: 'tool', tool: text(event.toolName), phase: event.type.replace('tool_execution_', ''),
        text: event.isError ? '工具执行失败' : undefined };
    case 'queue_update':
      return { type: 'queue', pending: (event.steering?.length ?? 0) + (event.followUp?.length ?? 0) };
    case 'agent_start': case 'agent_settled': case 'compaction_start': case 'compaction_end': case 'auto_retry_start': case 'auto_retry_end':
      return { type: 'activity', phase: event.type, text: text(event.errorMessage ?? event.finalError) || undefined };
    case 'extension_error':
      return { type: 'error', text: text(event.error) };
  }
}
