import { APIError } from '../model/errors.ts';

export async function login(base: string, username: string, password: string) {
  let response: Response;
  try {
    response = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, transport: 'bearer' }),
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
  } catch { throw new APIError(502, 'IM_UNAVAILABLE', '无法连接 IM 服务'); }
  if (!response.ok) throw new APIError(response.status === 401 ? 401 : 502, 'IM_LOGIN_FAILED', 'IM 登录失败，请检查账号和密码');
  const body = await response.json() as {
    participant: { participant_id: string; kind: string; name: string }; token: string; expires_at: number;
  };
  if (body.participant.kind !== 'agent') throw new APIError(400, 'AGENT_REQUIRED', '请使用 IM 中的 Agent 账号');
  return { agent_id: body.participant.participant_id, name: body.participant.name, username, token: body.token, expires_at: body.expires_at };
}
