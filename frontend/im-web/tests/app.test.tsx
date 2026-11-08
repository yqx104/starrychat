import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import type { Conversation, Message, MessagePage, Participant } from '../src/api/types';
import { App } from '../src/app/App';

const people: Participant[] = [
  { participant_id: 1, kind: 'human', name: '小语', created_at: 1 },
  { participant_id: 2, kind: 'agent', name: 'Mia', created_at: 1 },
  { participant_id: 3, kind: 'agent', name: 'Atlas', created_at: 1 },
  { participant_id: 4, kind: 'agent', name: 'Kai', created_at: 1 },
];
const group: Conversation = { conversation_id: 11, kind: 'group', title: '项目组', created_at: 100, dissolved_at: null };
const other: Conversation = { conversation_id: 22, kind: 'direct', title: 'Beta', created_at: 90, dissolved_at: null };
const msg = (id: number, content: string, conv = 11, quote: number | null = null): Message => ({ message_id: id, conversation_id: conv, sender_id: 2, content, created_at: 1700000000000, mentioned_agent_ids: [], quoted_message_id: quote });
function basic(conversations = [group]) {
  vi.spyOn(api, 'me').mockResolvedValue(people[0]);
  vi.spyOn(api, 'participants').mockResolvedValue(people);
  vi.spyOn(api, 'conversations').mockResolvedValue(conversations);
  vi.spyOn(api, 'getConversation').mockImplementation(async (id) => conversations.find((c) => c.conversation_id === id) ?? (id === group.conversation_id ? group : other));
  vi.spyOn(api, 'members').mockImplementation(async (id) => id === 11 ? people.slice(0, 3) : [people[0], people[3]]);
}

describe('chat flows', () => {
  it('keeps a failed message and submits Agent IDs and a quote, preserving newlines', async () => {
    basic();
    vi.spyOn(api, 'messages').mockResolvedValue({ messages: [msg(5, '需要引用的原文'), msg(6, '引用了未加载的消息', 11, 2)], has_more: false });
    const send = vi.spyOn(api, 'send').mockRejectedValueOnce(new Error('暂时发送失败')).mockResolvedValueOnce({ ...msg(7, '第一行\n第二行'), sender_id: 1, mentioned_agent_ids: [2, 3], quoted_message_id: 5 });
    const user = userEvent.setup(); render(<App />);
    expect(await screen.findByText('需要引用的原文')).toBeTruthy();
    expect(screen.getByText('引用的消息 #2 尚未加载')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '引用消息 5' }));
    await user.click(screen.getByRole('button', { name: '取消引用' }));
    await user.click(screen.getByRole('button', { name: '引用消息 5' }));
    const input = screen.getByRole('textbox', { name: '消息内容' });
    await user.type(input, '@Mia');
    await user.keyboard('{Enter}');
    await user.type(input, '@Atlas');
    await user.keyboard('{Enter}');
    await user.type(input, '第一行');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(input, '第二行');
    await user.click(screen.getByRole('button', { name: /发送/ }));
    expect(await screen.findByText('暂时发送失败')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).value).toBe('@Mia @Atlas 第一行\n第二行');
    expect(send.mock.calls[0]).toEqual([11, { content: '@Mia @Atlas 第一行\n第二行', mentioned_agent_ids: [2, 3], quoted_message_id: 5 }]);
    await user.click(screen.getByRole('button', { name: /发送/ }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).value).toBe(''));
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('manages members and requires confirmation before removal and dissolution', async () => {
    basic(); vi.spyOn(api, 'messages').mockResolvedValue({ messages: [msg(1, '保留的历史')], has_more: false });
    const add = vi.spyOn(api, 'addMember').mockResolvedValue(people[3]);
    const remove = vi.spyOn(api, 'removeMember').mockResolvedValue();
    const rename = vi.spyOn(api, 'rename').mockResolvedValue({ ...group, title: '新项目组' });
    const dissolve = vi.spyOn(api, 'dissolve').mockResolvedValue({ ...group, title: '新项目组', dissolved_at: 1700000000000 });
    const user = userEvent.setup(); render(<App />);
    await screen.findByText('保留的历史');
    await user.click(screen.getByRole('button', { name: '查看会话详情' }));
    await user.selectOptions(screen.getByLabelText('选择要加入的 Agent'), '4');
    await user.click(screen.getByRole('button', { name: '加入' }));
    await waitFor(() => expect(add).toHaveBeenCalledWith(11, 4));
    expect(await screen.findByRole('button', { name: '移除 Kai' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '移除 Atlas' }));
    expect(remove).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog', { name: '移除成员' })).getByRole('button', { name: '确认移除' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(11, 3));
    await user.click(screen.getByRole('button', { name: '编辑' }));
    const input = screen.getByRole('textbox', { name: '群聊名称' }); await user.clear(input); await user.type(input, '新项目组');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith(11, '新项目组'));
    await user.click(screen.getByRole('button', { name: '解散群聊' }));
    expect(dissolve).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog', { name: '解散群聊' })).getByRole('button', { name: '确认解散' }));
    expect(await screen.findByText('群聊已解散，历史消息仍可查看。')).toBeTruthy();
    expect(screen.getByText('保留的历史')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '移除 Mia' })).toBeNull();
  });
  it('ignores an old response when switching conversations and aborts its read', async () => {
    basic([group, other]);
    let resolveOld!: (page: MessagePage) => void; let oldSignal: AbortSignal | undefined;
    vi.spyOn(api, 'messages').mockImplementation((id, _query, signal) => id === 11 ? new Promise((resolve) => { oldSignal = signal; resolveOld = resolve; }) : Promise.resolve({ messages: [msg(10, '新会话内容', 22)], has_more: false }));
    const user = userEvent.setup(); render(<App />);
    await screen.findByRole('button', { name: /Beta/ });
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    await user.click(screen.getByRole('button', { name: /Beta/ }));
    expect(await screen.findByText('新会话内容')).toBeTruthy();
    expect(oldSignal?.aborted).toBe(true);
    resolveOld({ messages: [msg(4, '旧会话内容')], has_more: false });
    await waitFor(() => expect(screen.queryByText('旧会话内容')).toBeNull());
  });
  it('opens a direct chat from contacts and creates a group with selected IDs', async () => {
    basic([]); vi.spyOn(api, 'messages').mockResolvedValue({ messages: [], has_more: false });
    const direct = vi.spyOn(api, 'openDirect').mockResolvedValue(other);
    const create = vi.spyOn(api, 'createGroup').mockResolvedValue(group);
    const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByRole('button', { name: '通讯录' }));
    await user.click(screen.getByRole('button', { name: /Kai.*点击发起对话/ }));
    await waitFor(() => expect(direct).toHaveBeenCalledWith(4));
    await user.click(await screen.findByRole('button', { name: '查看会话详情' }));
    const details = screen.getByRole('complementary', { name: '会话详情' });
    expect(within(details).queryByRole('button', { name: /移除|编辑|解散群聊|加入/ })).toBeNull();
    await user.click(within(details).getByRole('button', { name: '关闭会话详情' }));
    await user.click(screen.getByRole('button', { name: '创建群聊' }));
    const dialog = screen.getByRole('dialog', { name: '创建群聊' });
    await user.type(within(dialog).getByLabelText('群聊名称'), '项目组');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Mia' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Atlas' }));
    await user.click(within(dialog).getByRole('button', { name: '创建群聊' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('项目组', [2, 3]));
  });
});
