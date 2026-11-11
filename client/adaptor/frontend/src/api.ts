export interface Agent {
  agent_id: string; name: string; username: string; enabled: boolean;
  connection_state: string; last_error: string | null; connected_at: number | null;
}
export interface InboxItem {
  id: number; state: string; received_at: number; channel_id: string;
  message: { content: string; message_id: string; channel_type: string; conversation_id: string; message_seq: number; sender_id: string };
}
export interface Config { adaptor_id: string; im_base_url: string; trigger_ws_url: string }

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/adaptor-api${path}`, {
    ...options, headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || '本机服务暂时不可用');
  return data as T;
}
