import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { Message } from '../../api/types';

const PAGE_SIZE = 50;
const POLL_INTERVAL = 10000;
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map(existing.map((item) => [item.message_id, item]));
  incoming.forEach((item) => byId.set(item.message_id, item));
  return [...byId.values()].sort((a, b) => a.message_seq - b.message_seq);
}

export function useMessages(conversationId: string, enabled = true) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [hasNewer, setHasNewer] = useState(false);
  const [version, setVersion] = useState(0);
  const messagesRef = useRef<Message[]>([]);
  const olderLock = useRef(false);
  const initialized = useRef(false);
  const cursor = useRef<number | null>(null);
  const active = useRef(false);
  const readAbort = useRef<AbortController | null>(null);
  const pollNow = useRef<() => void>(() => {});
  const merge = useCallback((items: Message[]) => {
    messagesRef.current = mergeMessages(messagesRef.current, items);
    setMessages(messagesRef.current);
  }, []);

  useEffect(() => {
    if (!enabled) { active.current = false; olderLock.current = false; setLoadingOlder(false); return; }
    let alive = true, busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const initialAbort = new AbortController();
    let pollAbort: AbortController | undefined;
    active.current = true;

    const schedule = () => {
      clearTimeout(timer);
      if (alive && document.visibilityState === 'visible') timer = setTimeout(() => { void poll(); }, POLL_INTERVAL);
    };
    const poll = async () => {
      if (!alive || !initialized.current || busy || document.visibilityState !== 'visible') return;
      clearTimeout(timer); busy = true; pollAbort = new AbortController();
      try {
        if (cursor.current === null) {
          // Backfill an initially empty conversation if more than one page arrived.
          const newest = await api.messages(conversationId, { limit: PAGE_SIZE }, pollAbort.signal);
          if (!alive || pollAbort.signal.aborted) return;
          let collected = newest.messages;
          let more = newest.has_more;
          let before = collected.length ? Math.min(...collected.map((item) => item.message_seq)) : null;
          while (more) {
            if (before === null) throw new Error('消息分页未返回可继续的位置。');
            const previous = await api.messages(conversationId, { limit: PAGE_SIZE, before_seq: before }, pollAbort.signal);
            if (!alive || pollAbort.signal.aborted) return;
            const next = previous.messages.length ? Math.min(...previous.messages.map((item) => item.message_seq)) : null;
            if (next === null || next >= before) throw new Error('消息分页未返回可继续的位置。');
            collected = [...previous.messages, ...collected]; before = next; more = previous.has_more;
          }
          if (!alive) return;
          merge(collected);
          if (collected.length) cursor.current = Math.max(...collected.map((item) => item.message_seq));
          setHasOlder(false);
        } else {
          let more = true;
          while (more) {
            const previousCursor: number = cursor.current;
            const nextPage = await api.messages(conversationId, { limit: PAGE_SIZE, after_seq: previousCursor }, pollAbort.signal);
            if (!alive) return;
            const next = nextPage.messages.length ? Math.max(...nextPage.messages.map((item) => item.message_seq)) : previousCursor;
            if ((nextPage.has_more || nextPage.messages.length) && next <= previousCursor) throw new Error('消息增量未返回可继续的位置。');
            merge(nextPage.messages); cursor.current = next; more = nextPage.has_more; setHasNewer(more);
          }
        }
        if (alive) setSyncError('');
      } catch (error) {
        if (alive && !(error instanceof Error && error.name === 'AbortError')) setSyncError(errorMessage(error));
      } finally {
        busy = false;
        if (alive) schedule();
      }
    };
    pollNow.current = () => { void poll(); };
    const visibility = () => {
      if (document.visibilityState === 'visible') void poll();
      else { clearTimeout(timer); pollAbort?.abort(); }
    };
    document.addEventListener('visibilitychange', visibility);
    if (initialized.current) {
      void poll();
    } else {
      setLoading(true); setLoadError('');
      void api.messages(conversationId, { limit: PAGE_SIZE }, initialAbort.signal).then((result) => {
        if (!alive || initialAbort.signal.aborted) return;
        merge(result.messages); setHasOlder(result.has_more);
        if (result.messages.length) cursor.current = Math.max(...result.messages.map((item) => item.message_seq));
        initialized.current = true; setLoading(false); schedule();
      }).catch((error: unknown) => {
        if (!alive || (error instanceof Error && error.name === 'AbortError')) return;
        setLoadError(errorMessage(error)); setLoading(false);
      });
    }
    return () => {
      alive = false; active.current = false; initialAbort.abort(); pollAbort?.abort();
      readAbort.current?.abort(); readAbort.current = null; olderLock.current = false;
      pollNow.current = () => {}; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility);
    };
  }, [conversationId, merge, version, enabled]);

  const loadOlder = useCallback(async () => {
    if (!active.current || olderLock.current || !hasOlder || !messagesRef.current.length) return;
    olderLock.current = true; setLoadingOlder(true); setOlderError('');
    const controller = new AbortController(); readAbort.current = controller;
    const first = messagesRef.current[0].message_seq;
    try {
      const result = await api.messages(conversationId, { limit: PAGE_SIZE, before_seq: first }, controller.signal);
      if (!active.current || controller.signal.aborted) return;
      if (result.has_more && (!result.messages.length || Math.min(...result.messages.map((item) => item.message_seq)) >= first)) throw new Error('消息分页未返回可继续的位置。');
      merge(result.messages); setHasOlder(result.has_more);
    } catch (error) {
      if (active.current && !controller.signal.aborted && !(error instanceof Error && error.name === 'AbortError')) setOlderError(errorMessage(error));
    } finally {
      if (readAbort.current === controller) {
        readAbort.current = null; olderLock.current = false;
        if (active.current) setLoadingOlder(false);
      }
    }
  }, [conversationId, hasOlder, merge]);

  return { messages, loading, loadError, hasOlder, loadingOlder, olderError, syncError, hasNewer, loadOlder, addMessage: merge, retryLoad: () => setVersion((value) => value + 1), retrySync: () => pollNow.current() };
}
