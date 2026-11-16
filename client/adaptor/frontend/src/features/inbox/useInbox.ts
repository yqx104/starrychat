import { useEffect, useState } from 'react';
import { getInbox } from '../../api/inbox';
import type { InboxItem } from '../../api/types';

export function useInbox(agentId: string | undefined, onError: (message: string) => void) {
  const [messages, setMessages] = useState<InboxItem[]>([]);
  const [before, setBefore] = useState<number>();
  const [hasMore, setHasMore] = useState(false);
  useEffect(() => {
    setMessages([]);
    setHasMore(false);
    if (!agentId) return;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const data = await getInbox(agentId, before, controller.signal);
        if (!controller.signal.aborted) {
          setMessages(data.messages);
          setHasMore(data.has_more);
        }
      } catch {
        if (!controller.signal.aborted) onError('收件箱读取失败，请稍后重试。');
      }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [agentId, before, onError]);

  return {
    messages,
    before,
    hasMore,
    reset: () => setBefore(undefined),
    older: () => setBefore(messages.at(-1)?.id),
  };
}
