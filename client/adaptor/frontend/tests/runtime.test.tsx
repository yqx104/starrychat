import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RuntimePanel } from '../src/features/runtime/RuntimePanel';
import { message, mia, mockApi, session } from './fixtures';

describe('runtime session', () => {
  it('advances event cursors, resets on a new epoch and stops polling on unmount', async () => {
    vi.useFakeTimers();
    const paths: string[] = [];
    let reads = 0;
    const fetch = mockApi((path) => {
      paths.push(path);
      if (path.includes('/events?')) {
        reads++;
        return {
          epoch: reads < 3 ? 'first' : 'second',
          truncated: reads === 1,
          events: [
            {
              id: reads < 3 ? reads : 1,
              at: 1,
              type: 'text',
              text: reads === 1 ? '第一段' : reads === 2 ? '第二段' : '重启后的事件',
            },
          ],
        };
      }
    });
    const view = render(<RuntimePanel agent={mia} messages={[]} />);
    await act(async () => {});
    expect(screen.getByText('第一段')).toBeTruthy();
    expect(screen.getByText('部分较早事件已超出缓存范围。')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText('第一段第二段')).toBeTruthy();
    expect(paths).toContain('/sessions/session-id/events?after=1&epoch=first');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(paths).toContain('/sessions/session-id/events?after=2&epoch=first');
    expect(screen.getByText('重启后的事件')).toBeTruthy();
    expect(screen.queryByText('第一段第二段')).toBeNull();
    expect(screen.queryByText('部分较早事件已超出缓存范围。')).toBeNull();
    view.unmount();
    const requests = fetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetch).toHaveBeenCalledTimes(requests);
  });

  it('requires confirmation before resolving an input and sends the selected action', async () => {
    const writes: { path: string; body: unknown }[] = [];
    mockApi((path, options) => {
      if (options.method === 'POST') {
        writes.push({ path, body: JSON.parse(String(options.body)) });
        return {};
      }
    });
    const user = userEvent.setup();
    render(<RuntimePanel agent={mia} messages={[message(17, '待核对的输入', 'needs_recovery')]} />);
    await screen.findByText('主会话 session-id');
    await user.click(screen.getByRole('button', { name: '确认重试' }));
    expect(writes).toEqual([]);
    await user.click(screen.getByRole('button', { name: '取消' }));
    await user.click(screen.getByRole('button', { name: '核对后标记已接收' }));
    await user.click(screen.getByRole('button', { name: '已核对，标记已接收' }));
    expect(writes).toEqual([
      {
        path: '/sessions/session-id/inputs/17/resolve',
        body: { action: 'accepted', confirmed: true },
      },
    ]);
  });

  it('aborts the active session and renders its returned state', async () => {
    const fetch = mockApi((path, options) => {
      if (path.endsWith('/abort') && options.method === 'POST')
        return { ...session, status: 'stopped' };
    });
    const user = userEvent.setup();
    render(<RuntimePanel agent={mia} messages={[]} />);
    await screen.findByText('主会话 session-id');
    await user.click(screen.getByRole('button', { name: '中止当前执行' }));
    expect(await screen.findByText('未启动')).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(
      '/adaptor-api/sessions/session-id/abort',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });
});
