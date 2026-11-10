import { testID } from './ids';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { Composer } from '../src/features/chat/Composer';

function renderComposer() {
  return render(<Composer conversationId={testID(1)} group={false} members={[]} participants={[]} quote={null} setQuote={() => {}} onSent={() => {}} disabled={false} />);
}

it('sends with Enter, inserts a newline with Shift+Enter, and keeps a failed draft', async () => {
  let fail!: (reason: Error) => void;
  const send = vi.spyOn(api, 'send').mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  const user = userEvent.setup(); renderComposer();
  const input = screen.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement;
  await user.click(input);
  await user.keyboard('{Enter}');
  expect(send).not.toHaveBeenCalled();
  expect(input.value).toBe('');
  await user.type(input, '第一行');
  await user.keyboard('{Shift>}{Enter}{/Shift}');
  expect(input.value).toBe('第一行\n');
  expect(send).not.toHaveBeenCalled();
  await user.type(input, '第二行');
  await user.keyboard('{Enter}');
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(testID(1), { content: '第一行\n第二行' });
  expect(input.disabled).toBe(true);
  await user.keyboard('{Enter}');
  expect(send).toHaveBeenCalledTimes(1);
  fail(new Error('发送失败'));
  expect(await screen.findByText('发送失败')).toBeTruthy();
  expect(input.value).toBe('第一行\n第二行');
  expect(input.disabled).toBe(false);
});

it('does not send when Enter confirms an IME composition, including legacy 229 events', async () => {
  const send = vi.spyOn(api, 'send').mockResolvedValue({ message_seq: 1, message_id: testID(1), conversation_id: testID(1), sender_id: testID(1), content: '待确认', created_at: 1, mentioned_agent_ids: [], quoted_message_id: null });
  const user = userEvent.setup(); renderComposer();
  const input = screen.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement;
  await user.type(input, '待确认');
  fireEvent.compositionStart(input);
  expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: false })).toBe(true);
  fireEvent.compositionEnd(input);
  expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: false, keyCode: 229 })).toBe(true);
  expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(true);
  expect(send).not.toHaveBeenCalled();
  expect(input.value).toBe('待确认');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(send).toHaveBeenCalledWith(testID(1), { content: '待确认' }));
});

const mentionPeople = [
  { participant_id: testID(1), kind: 'human' as const, name: '真人', created_at: 1 },
  { participant_id: testID(2), kind: 'agent' as const, name: 'Mia', created_at: 1 },
  { participant_id: testID(3), kind: 'agent' as const, name: 'Mia', created_at: 1 },
  { participant_id: testID(4), kind: 'agent' as const, name: 'Atlas', created_at: 1 },
  { participant_id: testID(5), kind: 'agent' as const, name: '未加入', created_at: 1 },
];
function renderMentions() {
  return render(<Composer conversationId={testID(1)} group members={mentionPeople.slice(0, 4)} participants={mentionPeople} quote={null} setQuote={() => {}} onSent={() => {}} disabled={false} />);
}
function response(content: string) {
  return { message_seq: 1, message_id: testID(1), conversation_id: testID(1), sender_id: testID(1), content, created_at: 1, mentioned_agent_ids: [], quoted_message_id: null };
}

it('opens and filters member suggestions, distinguishes names, and selects multiple IDs without sending', async () => {
  const send = vi.spyOn(api, 'send').mockResolvedValue(response('ok'));
  const user = userEvent.setup(); renderMentions();
  const input = screen.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement;
  await user.type(input, '前言 @');
  expect(screen.getAllByRole('option')).toHaveLength(3);
  expect(screen.queryByRole('option', { name: '真人' })).toBeNull();
  expect(screen.queryByRole('option', { name: '未加入' })).toBeNull();
  await user.type(input, 'Mi');
  expect(screen.getAllByRole('option')).toHaveLength(2);
  expect(screen.getByRole('option', { name: `Mia #${testID(2)}` })).toBeTruthy();
  expect(screen.getByRole('option', { name: `Mia #${testID(3)}` })).toBeTruthy();
  await user.keyboard('{ArrowDown}');
  fireEvent.select(input); // Browsers can emit select without changing the caret.
  await user.keyboard('{Enter}');
  expect(send).not.toHaveBeenCalled();
  expect(input.value).toBe('前言 @Mia ');
  expect(document.activeElement).toBe(input);
  await user.type(input, '和 @Atl');
  await user.click(screen.getByRole('option', { name: 'Atlas' }));
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('前言 @Mia 和 @Atlas ');
  expect([...document.querySelectorAll('.mention-highlight')].map((node) => node.textContent)).toEqual(['@Mia', '@Atlas']);
  expect(screen.queryByRole('listbox')).toBeNull();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(send).toHaveBeenCalledWith(testID(1), { content: '前言 @Mia 和 @Atlas ', mentioned_agent_ids: [testID(3), testID(4)] }));
});

it('removes only the ID belonging to an edited or deleted mention even when names match', async () => {
  const send = vi.spyOn(api, 'send').mockResolvedValue(response('ok'));
  const user = userEvent.setup(); renderMentions();
  const input = screen.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement;
  await user.type(input, '@Mia'); await user.keyboard('{Enter}');
  await user.type(input, '与 @Mia'); await user.keyboard('{ArrowDown}{Enter}');
  expect(input.value).toBe('@Mia 与 @Mia ');
  input.setSelectionRange(0, 4); fireEvent.select(input);
  await user.keyboard('{Backspace}');
  expect(input.value).toBe(' 与 @Mia ');
  expect([...document.querySelectorAll('.mention-highlight')].map((node) => node.textContent)).toEqual(['@Mia']);
  await user.keyboard('{Enter}');
  await waitFor(() => expect(send).toHaveBeenCalledWith(testID(1), { content: ' 与 @Mia ', mentioned_agent_ids: [testID(3)] }));
});

it('preserves surrounding text and invalidates an altered mention instead of guessing from its name', async () => {
  const send = vi.spyOn(api, 'send').mockResolvedValue(response('ok'));
  const user = userEvent.setup(); renderMentions();
  const input = screen.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement;
  await user.type(input, '前 existing 后');
  input.setSelectionRange(2, 10); fireEvent.select(input);
  await user.keyboard('@Atlas{Enter}');
  expect(input.value).toBe('前 @Atlas 后');
  input.setSelectionRange(4, 5); fireEvent.select(input);
  await user.keyboard('{Backspace}');
  expect(input.value).toBe('前 @Alas 后');
  expect(document.querySelectorAll('.mention-highlight')).toHaveLength(0);
  if (screen.queryByRole('listbox')) await user.keyboard('{Escape}');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(send).toHaveBeenCalledWith(testID(1), { content: '前 @Alas 后' }));
});

it('keeps Enter from choosing or sending during IME composition and lets Escape close the list', async () => {
  const send = vi.spyOn(api, 'send').mockResolvedValue(response('ok'));
  const user = userEvent.setup(); renderMentions();
  const input = screen.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement;
  await user.type(input, '@M');
  fireEvent.compositionStart(input);
  expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(true);
  fireEvent.compositionEnd(input);
  expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(true);
  expect(input.value).toBe('@M');
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByRole('listbox')).toBeTruthy();
  const staleOption = screen.getByRole('option', { name: `Mia #${testID(2)}` });
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.click(staleOption); // A closing popup cannot insert a stale candidate.
  expect(input.value).toBe('@M');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(send).toHaveBeenCalledWith(testID(1), { content: '@M' }));
});


it('closes suggestions when the trigger is removed or the caret leaves and keeps the insertion caret when text is unchanged', async () => {
  const user = userEvent.setup(); renderMentions();
  const input = screen.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement;
  await user.type(input, '@');
  expect(screen.getByRole('listbox')).toBeTruthy();
  await user.keyboard('{Backspace}');
  expect(screen.queryByRole('listbox')).toBeNull();
  await user.type(input, '开始 @Mia 结尾');
  expect(screen.queryByRole('listbox')).toBeNull();
  input.setSelectionRange(7, 7); fireEvent.select(input);
  expect(screen.getByRole('listbox')).toBeTruthy();
  await user.keyboard('{Enter}');
  expect(input.value).toBe('开始 @Mia 结尾');
  expect(input.selectionStart).toBe(8);
  expect(document.activeElement).toBe(input);
  expect(document.querySelector('.mention-highlight')?.textContent).toBe('@Mia');
  input.scrollTop = 30; fireEvent.scroll(input);
  expect((document.querySelector('.composer-mirror') as HTMLDivElement).scrollTop).toBe(30);
});

it('allows Shift+Enter while suggestions are open and ignores a held Enter after choosing', async () => {
  const send = vi.spyOn(api, 'send').mockResolvedValue(response('ok'));
  const user = userEvent.setup(); renderMentions();
  const input = screen.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement;
  await user.type(input, '@M');
  await user.keyboard('{Shift>}{Enter}{/Shift}');
  expect(input.value).toBe('@M\n');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(send).not.toHaveBeenCalled();
  await user.type(input, '@Atlas');
  await user.keyboard('{Enter}');
  fireEvent.keyDown(input, { key: 'Enter', repeat: true });
  expect(send).not.toHaveBeenCalled();
  expect(input.value).toBe('@M\n@Atlas ');
});


it('removes blue highlight and the outgoing ID when a chosen Agent leaves the conversation', async () => {
  const send = vi.spyOn(api, 'send').mockResolvedValue(response('ok'));
  const user = userEvent.setup();
  const props = { conversationId: testID(1), group: true, participants: mentionPeople, quote: null, setQuote: () => {}, onSent: () => {}, disabled: false };
  const view = render(<Composer {...props} members={mentionPeople.slice(0, 4)} />);
  const input = screen.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement;
  await user.type(input, '@Atlas'); await user.keyboard('{Enter}');
  expect(document.querySelector('.mention-highlight')?.textContent).toBe('@Atlas');
  view.rerender(<Composer {...props} members={mentionPeople.slice(0, 3)} />);
  expect(document.querySelector('.mention-highlight')).toBeNull();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(send).toHaveBeenCalledWith(testID(1), { content: '@Atlas ' }));
});
