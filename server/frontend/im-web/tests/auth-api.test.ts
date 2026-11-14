import { testID } from './ids';
import { describe, expect, it, vi } from 'vitest';
import { ImApi } from '../src/api/client';

const person = { participant_id: testID(7), kind: 'human', name: '用户', created_at: 100 };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('cookie authentication and request lifetime', () => {
  it('uses the cookie transport and same-origin credentials without exposing a token', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ participant: person }, 201)).mockResolvedValueOnce(json({ participant: person, expires_at: 1800000000000 }, 200, { 'Set-Cookie': 'im_token=opaque; HttpOnly; Path=/' })).mockResolvedValueOnce(json({ participant: person })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ImApi('/im-api', fetcher);
    await expect(client.register('name', 'secret', '用户')).resolves.toEqual(person);
    await expect(client.login('name', 'secret')).resolves.toEqual({ participant: person, expires_at: 1800000000000 });
    await expect(client.me()).resolves.toEqual(person);
    await client.logout();
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/im-api/auth/register', '/im-api/auth/login', '/im-api/auth/me', '/im-api/auth/logout']);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ username: 'name', password: 'secret', name: '用户' });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ username: 'name', password: 'secret', transport: 'cookie' });
    for (const [, request] of fetcher.mock.calls) expect(request.credentials).toBe('same-origin');
    expect(fetcher.mock.calls[1][1].headers).toEqual({ 'Content-Type': 'application/json' });
  });
  it('treats only an authenticated API 401 as session expiry', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ error: { code: 'UNAUTHORIZED', message: '登录失败' } }, 401)).mockResolvedValueOnce(json({ error: { code: 'UNAUTHORIZED', message: '登录过期' } }, 401));
    const client = new ImApi('', fetcher); const expired = vi.fn(); client.onUnauthorized(expired);
    await expect(client.login('bad', 'bad')).rejects.toMatchObject({ status: 401 });
    expect(expired).not.toHaveBeenCalled();
    await expect(client.conversations()).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
    await expect(client.participants()).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('aborts and drains old requests before logout and rejects late responses', async () => {
    let finish!: (response: Response) => void;
    let oldSignal: AbortSignal | undefined;
    const fetcher = vi.fn().mockImplementationOnce((_url, options) => { oldSignal = options.signal; return new Promise((resolve) => { finish = resolve; }); }).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ImApi('', fetcher);
    const old = client.conversations().catch((error: unknown) => error);
    const drained = client.suspendSession();
    expect(oldSignal?.aborted).toBe(true);
    let logoutStarted = false;
    const logout = drained.then(async () => { logoutStarted = true; await client.logout(); });
    await Promise.resolve(); expect(logoutStarted).toBe(false);
    finish(json({ conversations: [] }, 200, { 'Set-Cookie': 'im_token=old; HttpOnly; Path=/' }));
    await expect(old).resolves.toMatchObject({ name: 'AbortError' });
    await logout;
    expect(fetcher.mock.calls[1][0]).toBe('/auth/logout');
    expect(logoutStarted).toBe(true);
  });
});
