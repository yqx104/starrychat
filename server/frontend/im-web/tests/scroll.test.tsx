import { testID } from './ids';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { Message } from '../src/api/types';
import { MessageList } from '../src/features/chat/MessageList';

const message = (id: number): Message => ({ message_seq: id, message_id: testID(id), conversation_id: testID(1), sender_id: testID(2), content: `消息 ${id}`, created_at: 1700000000000, mentioned_agent_ids: [], quoted_message_id: null });

it('keeps the visible message in place when older history arrives, even if a new message arrives first', () => {
  let prepended = false;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const id = Number.parseInt(this.dataset.messageId?.slice(-12) ?? '', 16);
    const top = id ? 130 + (id - 3) * 70 + (prepended ? 100 : 0) : 100;
    return { top, bottom: top + 50, left: 0, right: 200, width: 200, height: 50, x: 0, y: top, toJSON() {} } as DOMRect;
  });
  const onOlder = vi.fn(() => new Promise<void>(() => {}));
  const common = { currentUser: { participant_id: testID(1), kind: 'human' as const, name: '我', created_at: 1 }, participants: [], hasOlder: true, olderError: '', onOlder, onQuote: () => {}, canQuote: true };
  const view = render(<MessageList {...common} messages={[message(3), message(4)]} loadingOlder={false} />);
  const scroll = screen.getByLabelText('消息记录'); scroll.scrollTop = 200;
  fireEvent.click(screen.getByRole('button', { name: '加载更早的消息' }));
  view.rerender(<MessageList {...common} messages={[message(3), message(4), message(5)]} loadingOlder />);
  expect(scroll.scrollTop).toBe(200);
  prepended = true;
  view.rerender(<MessageList {...common} messages={[message(1), message(2), message(3), message(4), message(5)]} loadingOlder={false} />);
  expect(scroll.scrollTop).toBe(300);
});
