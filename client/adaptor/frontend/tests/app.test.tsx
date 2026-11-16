import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/app/App';
import { message, mia, mockApi, nova } from './fixtures';

describe('adaptor workspace', () => {
  it('connects an existing account, reauthenticates it and toggles it without retaining passwords', async () => {
    const requests: { path: string; body: unknown }[] = [];
    let agents = [mia];
    mockApi((path, options) => {
      if (options.method) {
        const body = JSON.parse(String(options.body));
        requests.push({ path, body });
        const agent = { ...nova, enabled: body.enabled ?? nova.enabled };
        agents = [mia, agent];
        return { agent };
      }
      if (path === '/agents') return { agents };
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Mia' });
    await user.click(screen.getByRole('button', { name: '＋ 接入账号' }));
    let dialog = screen.getByRole('dialog', { name: '接入 Agent 账号' });
    await user.type(within(dialog).getByLabelText('用户名'), 'nova');
    await user.type(within(dialog).getByLabelText('密码'), 'fixture-password');
    await user.click(within(dialog).getByRole('button', { name: '验证并接入' }));
    await screen.findByRole('heading', { name: 'Nova' });
    expect(screen.queryByDisplayValue('fixture-password')).toBeNull();
    await user.click(screen.getByRole('button', { name: '重新认证' }));
    dialog = screen.getByRole('dialog', { name: '重新认证' });
    expect(within(dialog).getByLabelText('用户名')).toHaveProperty('value', 'nova');
    expect(within(dialog).getByLabelText('密码')).toHaveProperty('value', '');
    await user.type(within(dialog).getByLabelText('密码'), 'replacement-password');
    await user.click(within(dialog).getByRole('button', { name: '验证并接入' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: '启用 Agent' }));
    await screen.findByRole('button', { name: '停用 Agent' });
    expect(requests).toEqual([
      { path: '/agents', body: { username: 'nova', password: 'fixture-password' } },
      {
        path: '/agents/nova-id/reauthenticate',
        body: { username: 'nova', password: 'replacement-password' },
      },
      { path: '/agents/nova-id', body: { enabled: true } },
    ]);
  });

  it('shows a failed account submission and allows retry', async () => {
    let writes = 0;
    mockApi((path, options) => {
      if (path === '/agents' && options.method === 'POST') {
        if (++writes === 1)
          return new Response(JSON.stringify({ error: { message: '账号认证失败' } }), {
            status: 401,
          });
        return { agent: nova };
      }
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Mia' });
    await user.click(screen.getByRole('button', { name: '＋ 接入账号' }));
    await user.type(screen.getByLabelText('用户名'), 'nova');
    await user.type(screen.getByLabelText('密码'), 'fixture-password');
    await user.click(screen.getByRole('button', { name: '验证并接入' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '账号认证失败');
    await user.click(screen.getByRole('button', { name: '验证并接入' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes).toBe(2);
  });

  it('pages the inbox and resets the cursor when selecting another Agent', async () => {
    const paths: string[] = [];
    mockApi((path) => {
      paths.push(path);
      if (path === '/agents/mia-id/inbox?limit=50')
        return { messages: [message(50, '最新消息内容')], has_more: true };
      if (path.endsWith('before_id=50'))
        return { messages: [message(20, '历史消息内容')], has_more: false };
      if (path === '/agents/nova-id/inbox?limit=50')
        return { messages: [message(10, 'Nova 的消息')], has_more: false };
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('最新消息内容');
    await user.click(screen.getByRole('button', { name: '更早的消息 →' }));
    await screen.findByText('历史消息内容');
    await user.click(screen.getByRole('button', { name: /Nova.*@nova/ }));
    await screen.findByText('Nova 的消息');
    expect(screen.queryByRole('button', { name: '返回最新' })).toBeNull();
    expect(paths).toContain('/agents/nova-id/inbox?limit=50');
    expect(
      paths.some((path) => path.startsWith('/agents/nova-id/inbox') && path.includes('before_id')),
    ).toBe(false);
  });

  it('aborts and ignores an old inbox response after switching Agents', async () => {
    let finish!: (value: unknown) => void;
    let oldSignal: AbortSignal | null | undefined;
    const signals: AbortSignal[] = [];
    mockApi((path, options) => {
      if (options.signal) signals.push(options.signal);
      if (path === '/agents/mia-id/inbox?limit=50') {
        oldSignal = options.signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      if (path === '/agents/nova-id/inbox?limit=50')
        return { messages: [message(2, '当前 Agent 消息')], has_more: false };
    });
    const user = userEvent.setup();
    const view = render(<App />);
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    await user.click(screen.getByRole('button', { name: /Nova.*@nova/ }));
    await screen.findByText('当前 Agent 消息');
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => finish({ messages: [message(1, '过期消息')], has_more: true }));
    expect(screen.queryByText('过期消息')).toBeNull();
    view.unmount();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});
