export interface Agent {
  agent_id: string; name: string; username: string; enabled: boolean;
  connection_state: string; last_error: string | null; connected_at: number | null;
  session_status: string;
}
export interface InboxItem {
  id: number; state: string; received_at: number; channel_id: string;
  receipt_disposition: 'started' | 'queued' | 'handled' | null; last_error: string | null;
  message: { content: string; message_id: string; channel_type: string; conversation_id: string; message_seq: number; sender_id: string };
}
export interface Config { adaptor_id: string; im_base_url: string; trigger_ws_url: string }
export interface RuntimeConfig { harness: 'pi'; cwd: string; config: { pi_config_dir: string; provider?: string; model?: string; extensions?: string[] } }
export interface MainSession {
  status: string; blocked?: string | null; last_error: string | null; pending?: number;
  model?: { provider: string; id: string } | null;
  session: { session_id: string; harness: string; cwd: string; native_ref: { session_id: string; session_file: string | null } | null } | null;
}
export interface ExecutionEvent { id: number; at: number; type: string; text?: string; tool?: string; phase?: string; pending?: number }

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/adaptor-api${path}`, {
    ...options, headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || '本机服务暂时不可用');
  return data as T;
}
