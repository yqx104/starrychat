import { useEffect, useState } from 'react';
import { abortSession, getMainSession, getSessionEvents, resolveInput } from '../../api/runtime';
import type { ExecutionEvent, InboxItem, MainSession, RecoveryAction } from '../../api/types';

export function useRuntime(agentId: string) {
  const [view, setView] = useState<MainSession>();
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<{ item: InboxItem; action: RecoveryAction } | null>(
    null,
  );

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    let epoch = '';
    setView(undefined);
    setEvents([]);
    setError('');
    setTruncated(false);
    setEditing(false);
    const poll = async () => {
      try {
        const state = await getMainSession(agentId, controller.signal);
        if (controller.signal.aborted) return;
        setView(state);
        if (state.session) {
          const data = await getSessionEvents(
            state.session.session_id,
            cursor,
            epoch,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          const reset = epoch !== data.epoch;
          epoch = data.epoch;
          cursor = data.events.at(-1)?.id ?? (reset ? 0 : cursor);
          setEvents((current) => [...(reset ? [] : current), ...data.events].slice(-300));
          if (reset) setTruncated(data.truncated);
          else if (data.truncated) setTruncated(true);
        }
      } catch {
        if (!controller.signal.aborted) setError('会话状态读取失败，请检查本机服务。');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [agentId]);

  async function abort() {
    if (!view?.session) return;
    setBusy(true);
    setError('');
    try {
      setView(await abortSession(view.session.session_id));
    } catch (error) {
      setError(error instanceof Error ? error.message : '中止失败');
    } finally {
      setBusy(false);
    }
  }
  async function recover() {
    if (!view?.session || !recovery) return;
    const { item, action } = recovery;
    setBusy(true);
    setError('');
    try {
      await resolveInput(view.session.session_id, item.id, action);
      setView(await getMainSession(agentId));
      setRecovery(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : '恢复处理失败');
    } finally {
      setBusy(false);
    }
  }

  return {
    view,
    setView,
    events,
    truncated,
    error,
    setError,
    editing,
    setEditing,
    busy,
    recovery,
    setRecovery,
    abort,
    recover,
  };
}
