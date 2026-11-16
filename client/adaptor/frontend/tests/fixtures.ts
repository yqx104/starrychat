import { vi } from 'vitest';
import type { Agent, InboxItem, MainSession, RuntimeDetails } from '../src/api/types';

export const mia: Agent = {
  agent_id: 'mia-id',
  name: 'Mia',
  username: 'mia',
  enabled: false,
  connection_state: 'disabled',
  last_error: null,
  connected_at: null,
  session_status: 'idle',
};
export const nova: Agent = { ...mia, agent_id: 'nova-id', name: 'Nova', username: 'nova' };
export const session: MainSession = {
  status: 'idle',
  last_error: null,
  pending: 0,
  session: { session_id: 'session-id', harness: 'pi', cwd: '/workspace', native_ref: null },
};
export const runtime: RuntimeDetails = {
  runtime: {
    harness: 'pi',
    config: {
      provider: 'custom',
      model: 'model-a',
      extensions: ['/extension.ts'],
      system_prompt: { mode: 'default', text: '' },
    },
  },
  directories: { cwd: '/workspace', pi_config_dir: '/pi-config', sessions_dir: '/sessions' },
  configuration_issue: null,
  model_options: [
    {
      id: 'custom',
      base_url: 'https://example.test/v1',
      api: 'openai-completions',
      has_api_key: true,
      has_oauth: false,
      models: [
        {
          id: 'model-a',
          name: 'Model A',
          api: 'openai-completions',
          base_url: 'https://example.test/v1',
          builtin: false,
        },
      ],
    },
  ],
};
export function message(id: number, content: string, state = 'accepted'): InboxItem {
  return {
    id,
    state,
    received_at: 1700000000000,
    channel_id: 'channel-id',
    receipt_disposition: 'queued',
    last_error: null,
    message: {
      content,
      message_id: `message-${id}`,
      channel_type: 'im_direct',
      conversation_id: 'conversation-id',
      message_seq: id,
      sender_id: 'sender-id',
    },
  };
}
export function mockApi(
  handler: (path: string, options: RequestInit) => unknown = () => undefined,
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options = {}) => {
    const path = String(input).replace(/^\/adaptor-api/, '');
    let data = await handler(path, options);
    if (data === undefined) {
      if (path === '/config')
        data = {
          adaptor_id: 'local',
          im_base_url: 'http://im.test',
          trigger_ws_url: 'ws://trigger.test',
        };
      else if (path === '/agents') data = { agents: [mia, nova] };
      else if (path.includes('/inbox?')) data = { messages: [], has_more: false };
      else if (path.endsWith('/main-session')) data = session;
      else if (path.includes('/events?')) data = { epoch: 'first', events: [], truncated: false };
      else if (path.endsWith('/runtime')) data = runtime;
      else throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${path}`);
    }
    return data instanceof Response
      ? data
      : new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  });
}
