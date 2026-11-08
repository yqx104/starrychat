import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';
import type { Conversation, Message, MessagePage, Participant } from '../src/api/types';
import { App } from '../src/app/App';

const human: Participant = { participant_id: 1, kind: 'human', name: '小语', created_at: 1 };
const other: Participant = { participant_id: 9, kind: 'human', name: '另一账号', created_at: 1 };
const agent: Participant = { participant_id: 2, kind: 'agent', name: 'Mia', created_at: 1 };
const chat: Conversation = { conversation_id: 11, kind: 'group', title: '项目组', created_at: 10, dissolved_at: null };
const message = (id: number, content: string, sender = 1): Message => ({ message_id: id, conversation_id: 11, sender_id: sender, content, created_at: 1700000000000, mentioned_agent_ids: [], quoted_message_id: null });
const expired = new ApiError('登录已过期', 'UNAUTHORIZED', 401);
function workspace() {
  vi.spyOn(api, 'participants').mockResolvedValue([human, agent]);
  vi.spyOn(api, 'conversations').mockResolvedValue([chat]);
  vi.spyOn(api, 'getConversation').mockResolvedValue(chat);
  vi.spyOn(api, 'members').mockResolvedValue([human, agent]);
  vi.spyOn(api, 'messages').mockResolvedValue({ messages: [message(1, '旧消息')], has_more: false });
}

describe('authentication flow', () => {
  it('restores identity on startup and uses the authenticated participant for message ownership', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(other); workspace();
    vi.mocked(api.messages).mockResolvedValue({ messages: [message(1, '当前账号的消息', 9), message(2, '另一个真人的消息', 1)], has_more: false });
    render(<App />);
    const mine = await screen.findByText('当前账号的消息');
    const another = screen.getByText('另一个真人的消息');
    expect(mine.closest('article')?.classList.contains('message-row--own')).toBe(true);
    expect(another.closest('article')?.classList.contains('message-row--own')).toBe(false);
    expect(screen.getByRole('button', { name: '退出登录' })).toBeTruthy();
  });
  it('distinguishes expired login from a network failure and retries only on request', async () => {
    vi.spyOn(api, 'me').mockRejectedValueOnce(new ApiError('无法连接服务', 'NETWORK_ERROR')).mockRejectedValueOnce(expired);
    const user = userEvent.setup(); render(<App />);
    expect(await screen.findByText('无法连接服务')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '重新连接' }));
    expect(await screen.findByRole('button', { name: '登录' })).toBeTruthy();
    expect(api.me).toHaveBeenCalledTimes(2);
  });
  it('registers a human and logs in, and reports a registration conflict clearly', async () => {
    vi.spyOn(api, 'me').mockRejectedValue(expired); workspace();
    const register = vi.spyOn(api, 'register').mockRejectedValueOnce(new ApiError('conflict', 'CONFLICT', 409)).mockResolvedValueOnce(human);
    const login = vi.spyOn(api, 'login').mockResolvedValue({ participant: human, expires_at: 1800000000000 });
    const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByRole('button', { name: '注册账号' }));
    await user.type(screen.getByLabelText('账号'), 'newuser');
    await user.type(screen.getByLabelText('显示名称'), '小语');
    await user.type(screen.getByLabelText('密码'), 'password123');
    await user.click(screen.getByRole('button', { name: '创建并登录' }));
    expect(await screen.findByText(/用户名已被使用/)).toBeTruthy();
    expect(login).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '创建并登录' }));
    expect(await screen.findByText('旧消息')).toBeTruthy();
    expect(register).toHaveBeenCalledWith('newuser', 'password123', '小语');
    expect(login).toHaveBeenCalledWith('newuser', 'password123');
  });
  it('keeps a draft and quote on 401, resumes the same identity without retrying the write', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(human); workspace();
    let notify!: () => void;
    vi.spyOn(api, 'onUnauthorized').mockImplementation((listener) => { notify = listener; return () => {}; });
    const send = vi.spyOn(api, 'send').mockImplementation(async () => { void api.suspendSession(); notify(); throw expired; });
    vi.spyOn(api, 'login').mockResolvedValue({ participant: human, expires_at: 1800000000000 });
    const user = userEvent.setup(); render(<App />);
    await screen.findByText('旧消息');
    await user.click(screen.getByRole('button', { name: '引用消息 1' }));
    const input = screen.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement;
    await user.type(input, '@Mia'); await user.keyboard('{Enter}'); await user.type(input, '先保留草稿');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText(/登录已过期，请重新登录/)).toBeTruthy();
    await user.type(screen.getByLabelText('账号'), 'human'); await user.type(screen.getByLabelText('密码'), 'password123');
    await user.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).value).toBe('@Mia 先保留草稿'));
    expect(screen.getByRole('button', { name: '取消引用' })).toBeTruthy();
    expect(document.querySelector('.mention-highlight')?.textContent).toBe('@Mia');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('clears the old workspace on a different identity and ignores late responses', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(human); workspace();
    let notify!: () => void; let finishOld!: (page: MessagePage) => void;
    vi.spyOn(api, 'onUnauthorized').mockImplementation((listener) => { notify = listener; return () => {}; });
    vi.mocked(api.messages).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValue({ messages: [message(2, '新身份消息', 9)], has_more: false });
    vi.spyOn(api, 'login').mockResolvedValue({ participant: other, expires_at: 1800000000000 });
    const user = userEvent.setup(); render(<App />);
    await waitFor(() => expect(finishOld).toBeTypeOf('function'));
    act(() => { void api.suspendSession(); notify(); });
    await user.type(await screen.findByLabelText('账号'), 'other'); await user.type(screen.getByLabelText('密码'), 'password123');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('新身份消息')).toBeTruthy();
    await act(async () => finishOld({ messages: [message(1, '迟到的旧消息')], has_more: false }));
    expect(screen.queryByText('迟到的旧消息')).toBeNull();
  });
  it('waits for pending requests before logout and clears the previous draft', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(human); workspace();
    vi.spyOn(api, 'login').mockResolvedValue({ participant: human, expires_at: 1800000000000 });
    const logout = vi.spyOn(api, 'logout').mockResolvedValue();
    const user = userEvent.setup(); render(<App />);
    await screen.findByText('旧消息');
    await user.type(screen.getByRole('textbox', { name: '消息内容' }), '不应跨退出保留');
    let release!: () => void;
    vi.spyOn(api, 'suspendSession').mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
    await user.click(screen.getByRole('button', { name: '退出登录' }));
    expect(screen.getByText('正在退出登录')).toBeTruthy(); expect(logout).not.toHaveBeenCalled();
    await act(async () => release());
    expect(await screen.findByRole('button', { name: '登录' })).toBeTruthy();
    expect(logout).toHaveBeenCalledTimes(1);
    await user.type(screen.getByLabelText('账号'), 'human'); await user.type(screen.getByLabelText('密码'), 'password123');
    await user.click(screen.getByRole('button', { name: '登录' }));
    const input = await screen.findByRole('textbox', { name: '消息内容' });
    expect((input as HTMLTextAreaElement).value).toBe('');
  });
});

it('prevents duplicate login submissions while a request is pending', async () => {
  vi.spyOn(api, 'me').mockRejectedValue(expired);
  let complete!: (session: { participant: Participant; expires_at: number }) => void;
  const login = vi.spyOn(api, 'login').mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  workspace();
  const user = userEvent.setup(); render(<App />);
  await user.type(await screen.findByLabelText('账号'), 'human');
  await user.type(screen.getByLabelText('密码'), 'password123');
  await user.click(screen.getByRole('button', { name: '登录' }));
  expect((screen.getByRole('button', { name: '登录中…' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.submit(screen.getByLabelText('密码').closest('form')!);
  expect(login).toHaveBeenCalledTimes(1);
  await act(async () => complete({ participant: human, expires_at: 1800000000000 }));
  expect(await screen.findByText('旧消息')).toBeTruthy();
});
