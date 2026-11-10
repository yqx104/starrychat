import { testID } from './ids';
import { act, fireEvent, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import type { Message, MessagePage, MessageQuery } from '../src/api/types';
import { mergeMessages, useMessages } from '../src/features/chat/useMessages';

const msg = (id: number): Message => ({ message_seq: id, message_id: testID(id), conversation_id: testID(1), sender_id: testID(2), content: String(id), created_at: 1700000000000, mentioned_agent_ids: [], quoted_message_id: null });

describe('message synchronization', () => {
  it('keeps older history separate from multi-page increments and does not skip around a sent message', async () => {
    const call = vi.spyOn(api, 'messages').mockImplementation(async (_id, query: MessageQuery = {}) => {
      if (query.before_seq === 100) return { messages: [msg(98), msg(99)], has_more: false };
      if (query.after_seq === 101) return { messages: [msg(102)], has_more: true };
      if (query.after_seq === 102) return { messages: [msg(103), msg(104)], has_more: false };
      return { messages: [msg(100), msg(101)], has_more: true };
    });
    const { result } = renderHook(() => useMessages(testID(1)));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.addMessage([msg(104)]));
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(result.current.messages.map((m) => m.message_seq)).toEqual([100, 101, 102, 103, 104]));
    expect(result.current.hasOlder).toBe(true);
    expect(call.mock.calls.filter(([, q]) => q?.after_seq).map(([, q]) => q?.after_seq)).toEqual([101, 102]);
    await act(async () => { await result.current.loadOlder(); });
    expect(result.current.messages.map((m) => m.message_seq)).toEqual([98, 99, 100, 101, 102, 103, 104]);
    expect(result.current.hasOlder).toBe(false);
  });
  it('backfills pages when messages arrive after an initially empty conversation', async () => {
    let initialCalls = 0;
    vi.spyOn(api, 'messages').mockImplementation(async (_id, query: MessageQuery = {}) => {
      if (query.before_seq === 3) return { messages: [msg(1), msg(2)], has_more: false };
      if (!query.before_seq && !query.after_seq && initialCalls++ === 0) return { messages: [], has_more: false };
      return { messages: [msg(3), msg(4)], has_more: true };
    });
    const { result } = renderHook(() => useMessages(testID(1)));
    await waitFor(() => expect(result.current.loading).toBe(false));
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(result.current.messages.map((m) => m.message_seq)).toEqual([1, 2, 3, 4]));
    expect(result.current.hasOlder).toBe(false);
  });
  it('does not overlap polls and aborts the in-flight read when unmounted', async () => {
    let resolve!: (page: MessagePage) => void;
    let pollSignal: AbortSignal | undefined;
    const call = vi.spyOn(api, 'messages').mockImplementation((_id, query, signal) => {
      if (query?.after_seq) { pollSignal = signal; return new Promise((done) => { resolve = done; }); }
      return Promise.resolve({ messages: [msg(1)], has_more: false });
    });
    const { result, unmount } = renderHook(() => useMessages(testID(1)));
    await waitFor(() => expect(result.current.loading).toBe(false));
    fireEvent(document, new Event('visibilitychange')); fireEvent(document, new Event('visibilitychange'));
    expect(call.mock.calls.filter(([, q]) => q?.after_seq).length).toBe(1);
    unmount(); expect(pollSignal?.aborted).toBe(true);
    await act(async () => resolve({ messages: [msg(2)], has_more: false }));
  });
  it('pauses and resumes a session without losing loaded messages or advancing past a sent message', async () => {
    let resolveOld!: (page: MessagePage) => void;
    let oldSignal: AbortSignal | undefined;
    let polls = 0;
    vi.spyOn(api, 'messages').mockImplementation((_id, query, signal) => {
      if (query?.after_seq) {
        if (polls++ === 0) { oldSignal = signal; return new Promise((resolve) => { resolveOld = resolve; }); }
        return Promise.resolve({ messages: [msg(2), msg(3)], has_more: false });
      }
      return Promise.resolve({ messages: [msg(1)], has_more: true });
    });
    const { result, rerender } = renderHook(({ enabled }) => useMessages(testID(1), enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.addMessage([msg(4)]));
    fireEvent(document, new Event('visibilitychange'));
    expect(polls).toBe(1);
    rerender({ enabled: false });
    expect(oldSignal?.aborted).toBe(true);
    fireEvent(document, new Event('visibilitychange'));
    expect(polls).toBe(1);
    expect(result.current.messages.map((item) => item.message_seq)).toEqual([1, 4]);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.messages.map((item) => item.message_seq)).toEqual([1, 2, 3, 4]));
    expect(result.current.hasOlder).toBe(true);
    await act(async () => resolveOld({ messages: [msg(99)], has_more: false }));
    expect(result.current.messages.map((item) => item.message_seq)).toEqual([1, 2, 3, 4]);
  });

});

it('sorts by conversation sequence even when UUIDs and timestamps are reversed, and deduplicates by UUID', () => {
  const first = { ...msg(1), message_id: testID(999), created_at: 200 };
  const second = { ...msg(2), message_id: testID(5), created_at: 100 };
  expect(mergeMessages([second, first], [{ ...first, content: 'Updated' }])).toEqual([{ ...first, content: 'Updated' }, second]);
});
