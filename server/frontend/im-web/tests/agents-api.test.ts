import { testID } from './ids';
import { describe, expect, it, vi } from 'vitest';
import { ImApi } from '../src/api/client';

const agent = { participant_id: testID(9), kind: 'agent', name: '助手', username: 'agent.one', owner_participant_id: testID(1), created_at: 100 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('Agent account API', () => {
  it('uses the specified endpoints and sends no owner or kind fields', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ agents: [agent] })).mockResolvedValueOnce(json({ agent }, 201)).mockResolvedValueOnce(json({ agent: { ...agent, name: '新助手' } }));
    const client = new ImApi('/im-api', fetcher);
    await expect(client.agents()).resolves.toEqual([agent]);
    await expect(client.createAgent({ name: '助手', username: 'agent.one', password: 'test-only-pass', owner_participant_id: testID(99), kind: 'human' } as never)).resolves.toEqual(agent);
    await expect(client.updateAgent(testID(9), { name: '新助手', owner_participant_id: testID(99) } as never)).resolves.toMatchObject({ name: '新助手' });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/im-api/agents', '/im-api/agents', `/im-api/agents/${testID(9)}`]);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ name: '助手', username: 'agent.one', password: 'test-only-pass' });
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ name: '新助手' });
    expect(fetcher.mock.calls[1][1].credentials).toBe('same-origin');
  });
  it('rejects bad ownership fields, mismatched IDs and empty patches', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ agents: [{ ...agent, owner_participant_id: 0 }] })).mockResolvedValueOnce(json({ agent: { ...agent, participant_id: testID(10) } }));
    const client = new ImApi('', fetcher);
    await expect(client.agents()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(client.updateAgent(testID(9), { name: '新助手' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(client.updateAgent(testID(9), {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
