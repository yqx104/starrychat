import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import type { Conversation, Participant } from '../src/api/types';
import { App } from '../src/app/App';
import { testID } from './ids';

const human: Participant = { participant_id: testID(1), kind: 'human', name: '用户', created_at: 1 };
const agent: Participant = { participant_id: testID(2), kind: 'agent', name: 'Mia', created_at: 2 };
const group: Conversation = { conversation_id: testID(11), kind: 'group', title: '项目组', created_at: 100, dissolved_at: null, hidden: false };
const direct: Conversation = { conversation_id: testID(12), kind: 'direct', title: 'Mia', created_at: 90, dissolved_at: null, hidden: false };

function fixture(initial: Conversation[]) {
  let saved = initial.map((chat) => ({ ...chat }));
  const get = (id: string) => ({ ...saved.find((chat) => chat.conversation_id === id)! });
  const saveVisibility = (id: string, hidden: boolean) => {
    saved = saved.map((chat) => chat.conversation_id === id ? { ...chat, hidden } : chat);
    return get(id);
  };
  vi.spyOn(api, 'me').mockResolvedValue(human);
  vi.spyOn(api, 'participants').mockResolvedValue([human, agent]);
  vi.spyOn(api, 'conversations').mockImplementation(async () => saved.map((chat) => ({ ...chat })));
  vi.spyOn(api, 'getConversation').mockImplementation(async (id) => get(id));
  vi.spyOn(api, 'members').mockResolvedValue([human, agent]);
  vi.spyOn(api, 'messages').mockImplementation(async (id) => ({ messages: [{
    message_seq: 1, message_id: id === group.conversation_id ? testID(31) : testID(32),
    conversation_id: id, sender_id: agent.participant_id, content: id === group.conversation_id ? '群聊历史' : '单聊历史',
    created_at: 1700000000000, mentioned_agent_ids: [], quoted_message_id: null,
  }], has_more: false }));
  const visibility = vi.spyOn(api, 'setVisibility').mockImplementation(async (id, hidden) => saveVisibility(id, hidden));
  const openDirect = vi.spyOn(api, 'openDirect').mockImplementation(async () => saveVisibility(direct.conversation_id, false));
  return { visibility, openDirect };
}

describe('conversation list visibility', () => {
  it('keeps a removed group in group management across reload and opens its original history', async () => {
    const { visibility } = fixture([group, direct]);
    const user = userEvent.setup();
    const view = render(<App />);
    await screen.findByText('群聊历史');
    await user.click(screen.getByRole('button', { name: '从消息列表移除 项目组' }));
    await waitFor(() => expect(within(screen.getByRole('complementary', { name: '会话列表' })).queryByRole('button', { name: /^项目组/ })).toBeNull());
    expect(await screen.findByText('单聊历史')).toBeTruthy();

    view.unmount();
    render(<App />);
    const chats = await screen.findByRole('complementary', { name: '会话列表' });
    expect(within(chats).queryByRole('button', { name: /^项目组/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '群聊' }));
    const groups = screen.getByRole('complementary', { name: '群聊列表' });
    expect(within(groups).queryByRole('button', { name: /^Mia/ })).toBeNull();
    await user.type(screen.getByRole('textbox', { name: '搜索群聊' }), '项目');
    await user.click(within(groups).getByRole('button', { name: /^项目组/ }));
    expect(await screen.findByText('群聊历史')).toBeTruthy();
    expect(screen.getByRole('button', { name: '消息' }).getAttribute('aria-current')).toBe('page');
    expect((screen.getByRole('textbox', { name: '搜索会话' }) as HTMLInputElement).value).toBe('');
    expect(visibility.mock.calls).toEqual([[group.conversation_id, true], [group.conversation_id, false]]);
    expect(within(screen.getByRole('complementary', { name: '会话列表' })).getByRole('button', { name: /^项目组/ })).toBeTruthy();
  });

  it('removes the last direct chat and restores it through its Agent after reload', async () => {
    const { openDirect } = fixture([direct]);
    const user = userEvent.setup();
    const view = render(<App />);
    await screen.findByText('单聊历史');
    await user.click(screen.getByRole('button', { name: '从消息列表移除 Mia' }));
    expect(await screen.findByRole('heading', { name: '你好，开始对话吧' })).toBeTruthy();
    expect(screen.queryByText('单聊历史')).toBeNull();
    view.unmount();
    render(<App />);
    await screen.findByRole('heading', { name: '你好，开始对话吧' });
    await user.click(screen.getByRole('button', { name: '通讯录' }));
    await user.click(within(screen.getByRole('complementary', { name: '通讯录' })).getByRole('button', { name: /^Mia/ }));
    expect(await screen.findByText('单聊历史')).toBeTruthy();
    expect(openDirect).toHaveBeenCalledWith(agent.participant_id);
    expect(screen.getByRole('button', { name: '消息' }).getAttribute('aria-current')).toBe('page');
  });

  it('keeps the current chat visible when saving visibility fails and allows retry', async () => {
    const { visibility } = fixture([group]);
    visibility.mockRejectedValueOnce(new Error('暂时无法保存'));
    const user = userEvent.setup(); render(<App />);
    await screen.findByText('群聊历史');
    await user.click(screen.getByRole('button', { name: '从消息列表移除 项目组' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '暂时无法保存');
    expect(screen.getByText('群聊历史')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '从消息列表移除 项目组' }));
    expect(await screen.findByRole('heading', { name: '你好，开始对话吧' })).toBeTruthy();
    expect(visibility).toHaveBeenCalledTimes(2);
  });

  it('lists hidden dissolved groups and restores their read-only history', async () => {
    fixture([{ ...group, hidden: true, dissolved_at: 1700000000000 }]);
    const user = userEvent.setup(); render(<App />);
    await screen.findByRole('heading', { name: '你好，开始对话吧' });
    await user.click(screen.getByRole('button', { name: '群聊' }));
    await user.click(within(screen.getByRole('complementary', { name: '群聊列表' })).getByRole('button', { name: /^项目组/ }));
    expect(await screen.findByText('群聊历史')).toBeTruthy();
    expect(await screen.findByText('群聊已解散，历史消息仍可查看。')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '消息内容' })).toBeNull();
  });
});
