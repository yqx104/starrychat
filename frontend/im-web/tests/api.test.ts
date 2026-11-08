import { describe, expect, it, vi } from 'vitest';
import { ImApi, ApiError } from '../src/api/client';

const message = { message_id: 5, conversation_id: 3, sender_id: 1, content: '原文\n第二行', created_at: 1700000000000, mentioned_agent_ids: [2, 4], quoted_message_id: 2 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('IM API', () => {
  it('sends directional pagination and stable mention/quote IDs without inventing identity', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ messages: [message], has_more: false })).mockResolvedValueOnce(json({ message }, 201));
    const client = new ImApi('/api', fetcher);
    await client.messages(3, { limit: 50, after_message_id: 4 });
    await client.send(3, { content: '原文\n第二行', mentioned_agent_ids: [2, 4], quoted_message_id: 2 });
    expect(fetcher.mock.calls[0][0]).toBe('/api/conversations/3/messages?limit=50&after_message_id=4');
    expect(fetcher.mock.calls[1][0]).toBe('/api/conversations/3/messages');
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ content: '原文\n第二行', mentioned_agent_ids: [2, 4], quoted_message_id: 2 });
    expect(fetcher.mock.calls[1][1].headers).toEqual({ 'Content-Type': 'application/json' });
    await expect(client.messages(3, { limit: 51 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.messages(3, { before_message_id: 1, after_message_id: 2 } as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('preserves API errors and rejects network, malformed, and cross-conversation responses', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ error: { code: 'FORBIDDEN', message: '没有权限' } }, 403)).mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(new Response('bad', { status: 200 })).mockResolvedValueOnce(json({ messages: [{ ...message, conversation_id: 4 }], has_more: false })).mockResolvedValueOnce(new Response('proxy failed', { status: 502 }));
    const client = new ImApi('', fetcher);
    await expect(client.conversations()).rejects.toMatchObject({ code: 'FORBIDDEN', message: '没有权限', status: 403 });
    await expect(client.conversations()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(client.conversations()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(client.messages(3)).rejects.toBeInstanceOf(ApiError);
    await expect(client.conversations()).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 502, message: expect.stringContaining('无法连接 IM 服务') });
  });
  it('rejects malformed page cursors instead of silently reporting success', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ messages: [], has_more: true })).mockResolvedValueOnce(json({ messages: [message], has_more: false }));
    const client = new ImApi('', fetcher);
    await expect(client.messages(3)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(client.messages(3, { after_message_id: 5 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
