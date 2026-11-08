import { useLayoutEffect, useRef } from 'react';
import type { Message, Participant } from '../../api/types';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Notice } from '../../components/Notice';
import { formatDate, formatTime } from '../conversations/labels';

export function MessageList({ currentUser, messages, participants, hasOlder, loadingOlder, olderError, onOlder, onQuote, canQuote }: {
  currentUser: Participant; messages: Message[]; participants: Participant[]; hasOlder: boolean; loadingOlder: boolean; olderError: string; onOlder: () => Promise<void>; onQuote: (message: Message) => void; canQuote: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ id: string; offset: number; firstId: string } | null>(null);
  const nearBottom = useRef(true);
  const initial = useRef(true);
  const byId = new Map(messages.map((message) => [message.message_id, message]));
  const people = new Map(participants.map((participant) => [participant.participant_id, participant]));
  people.set(currentUser.participant_id, currentUser);
  const loadOlder = () => {
    const element = scroll.current;
    if (!element || !hasOlder || loadingOlder) return;
    const top = element.getBoundingClientRect().top;
    const firstVisible = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find((item) => item.getBoundingClientRect().bottom >= top);
    if (firstVisible) anchor.current = { id: firstVisible.dataset.messageId!, offset: firstVisible.getBoundingClientRect().top - top, firstId: messages[0].message_id };
    void onOlder();
  };
  useLayoutEffect(() => {
    const element = scroll.current; if (!element) return;
    if (anchor.current) {
      if (messages[0]?.message_id !== anchor.current.firstId) {
        const target = element.querySelector<HTMLElement>(`[data-message-id="${anchor.current.id}"]`);
        if (target) element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.current.offset;
        anchor.current = null;
      } else if (!loadingOlder) anchor.current = null;
    } else if (initial.current || nearBottom.current) element.scrollTop = element.scrollHeight;
    initial.current = false;
  }, [messages, loadingOlder]);
  return <div ref={scroll} className="message-scroll" aria-label="消息记录" onScroll={(event) => {
    const element = event.currentTarget; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
    if (element.scrollTop < 45 && !olderError) loadOlder();
  }}>
    <div className="message-inner">
      {hasOlder && <div className="history-control"><button onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? '加载中…' : '加载更早的消息'}</button></div>}
      {olderError && <Notice text={olderError} onRetry={loadOlder} compact />}
      {!hasOlder && messages.length > 0 && <div className="history-start">已显示全部历史消息</div>}
      {!messages.length && <div className="message-empty"><span className="empty-orb"><Icon name="chat" /></span><strong>开始一段新的对话</strong><p>发一条消息，和你的团队聊聊吧。</p></div>}
      {messages.map((message, index) => {
        const sender = people.get(message.sender_id);
        const own = message.sender_id === currentUser.participant_id;
        const quoted = message.quoted_message_id === null ? null : byId.get(message.quoted_message_id);
        const day = new Date(message.created_at).toDateString();
        const previousDay = index ? new Date(messages[index - 1].created_at).toDateString() : '';
        return <div key={message.message_id} data-message-id={message.message_id}>
          {day !== previousDay && <div className="date-divider"><span>{formatDate(message.created_at)}</span></div>}
          <article className={`message-row ${own ? 'message-row--own' : ''}`}>
            <Avatar name={sender?.name ?? '?'} id={message.sender_id} size="small" />
            <div className="message-content"><div className="message-meta"><strong>{sender?.name ?? `成员 #${message.sender_id}`}</strong><time dateTime={new Date(message.created_at).toISOString()}>{formatTime(message.created_at)}</time></div>
              <div className="message-bubble">
                {message.quoted_message_id !== null && <div className="quote-preview">{quoted ? <><strong>{people.get(quoted.sender_id)?.name ?? `成员 #${quoted.sender_id}`}</strong><span>{quoted.content}</span></> : <span>引用的消息 #{message.quoted_message_id} 尚未加载</span>}</div>}
                <div className="message-text">{message.content}</div>
                {message.mentioned_agent_ids.length > 0 && <div className="message-mentions">{message.mentioned_agent_ids.map((id) => <span key={id}>@{people.get(id)?.name ?? `Agent #${id}`}</span>)}</div>}
              </div>
              {canQuote && <button className="reply-button" onClick={() => onQuote(message)} aria-label={`引用消息 ${message.message_id}`}><Icon name="reply" /> 引用</button>}
            </div>
          </article>
        </div>;
      })}
    </div>
  </div>;
}
