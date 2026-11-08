import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Message, Participant } from '../../api/types';
import { api, errorMessage } from '../../api/client';
import { Icon } from '../../components/Icon';
import { Notice } from '../../components/Notice';
import { applyInput, mentionQuery, replaceDraft, type Draft, type MentionQuery, type Selection } from './mentions';

export function Composer({ conversationId, members, participants, quote, setQuote, onSent, disabled }: {
  conversationId: string; group: boolean; members: Participant[]; participants: Participant[]; quote: Message | null; setQuote: (message: Message | null) => void; onSent: (message: Message) => void; disabled: boolean;
}) {
  const [draft, setDraft] = useState<Draft>({ text: '', mentions: [] });
  const draftRef = useRef(draft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<Selection>({ start: 0, end: 0 });
  const pendingCaret = useRef<number | null>(null);
  const composing = useRef(false);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const queryRef = useRef<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const agents = members.filter((member) => member.kind === 'agent');
  const candidates = query ? agents.filter((agent) => agent.name.toLocaleLowerCase().includes(query.text.toLocaleLowerCase())) : [];
  const active = candidates[Math.min(activeIndex, candidates.length - 1)];
  const popupMemory = useRef<Participant[]>([]);
  useLayoutEffect(() => { if (query) popupMemory.current = candidates; }, [query, members]);
  const shownCandidates = query ? candidates : popupMemory.current;
  const validAgents = new Set(agents.map((agent) => agent.participant_id));
  const highlighted: ReactNode[] = [];
  let highlightedThrough = 0;
  draft.mentions.filter((mention) => validAgents.has(mention.id)).forEach((mention) => {
    highlighted.push(draft.text.slice(highlightedThrough, mention.start));
    highlighted.push(<span className="mention-highlight" key={`${mention.start}-${mention.id}`}>{draft.text.slice(mention.start, mention.end)}</span>);
    highlightedThrough = mention.end;
  });
  highlighted.push(draft.text.slice(highlightedThrough));
  const listId = 'mention-candidates';
  const quotedSender = participants.find((p) => p.participant_id === quote?.sender_id)?.name ?? `成员 #${quote?.sender_id}`;

  const selectionOf = (element: HTMLTextAreaElement): Selection => ({ start: element.selectionStart, end: element.selectionEnd });
  const rememberSelection = (element: HTMLTextAreaElement) => { selectionRef.current = selectionOf(element); };
  const closeQuery = () => { queryRef.current = null; setQuery(null); };
  const updateQuery = (next: Draft, selection: Selection) => {
    const possible = mentionQuery(next, selection);
    const hasMatches = possible && agents.some((agent) => agent.name.toLocaleLowerCase().includes(possible.text.toLocaleLowerCase()));
    const nextQuery = possible && (/\s/.test(possible.text) && !hasMatches) ? null : possible;
    const previous = queryRef.current;
    if (previous?.start === nextQuery?.start && previous?.end === nextQuery?.end && previous?.text === nextQuery?.text) return;
    queryRef.current = nextQuery; setQuery(nextQuery); setActiveIndex(0);
  };
  const change = (element: HTMLTextAreaElement) => {
    const next = applyInput(draftRef.current, element.value, selectionRef.current, element.selectionStart);
    draftRef.current = next; setDraft(next);
    const selection = selectionOf(element); selectionRef.current = selection;
    updateQuery(next, selection);
  };
  const choose = (agent: Participant) => {
    const current = queryRef.current;
    if (!current || composing.current || !agents.some((member) => member.participant_id === agent.participant_id && member.name.toLocaleLowerCase().includes(current.text.toLocaleLowerCase()))) return;
    const label = `@${agent.name}`;
    const suffix = draftRef.current.text.slice(current.end);
    const separator = /^\s/.test(suffix) ? '' : ' ';
    const next = replaceDraft(draftRef.current, current.start, current.end, label + separator);
    next.mentions.push({ id: agent.participant_id, start: current.start, end: current.start + label.length });
    next.mentions.sort((a, b) => a.start - b.start);
    draftRef.current = next; setDraft(next); closeQuery();
    pendingCaret.current = current.start + label.length + (separator || suffix.startsWith(' ') ? 1 : 0);
  };
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !textareaRef.current) return;
    const element = textareaRef.current;
    element.focus(); element.setSelectionRange(pendingCaret.current, pendingCaret.current);
    rememberSelection(element); pendingCaret.current = null;
  }, [draft]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!query || !active || !menu) return;
    const option = menu.querySelector<HTMLElement>(`[id="${listId}-${active.participant_id}"]`);
    if (!option) return;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
  }, [query, active?.participant_id]);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!draft.text.trim() || sending || disabled) return;
    setSending(true); setError('');
    const mentionedIds = [...new Set(draft.mentions.filter((mention) => validAgents.has(mention.id)).map((mention) => mention.id))];
    try {
      const message = await api.send(conversationId, { content: draft.text, ...(mentionedIds.length ? { mentioned_agent_ids: mentionedIds } : {}), ...(quote ? { quoted_message_id: quote.message_id } : {}) });
      onSent(message); const empty = { text: '', mentions: [] }; draftRef.current = empty; setDraft(empty); setQuote(null); closeQuery();
    } catch (e) { setError(errorMessage(e)); } finally { setSending(false); }
  };
  if (disabled) return <div className="composer-disabled"><Icon name="info" /> 群聊已解散，历史消息仍可查看。</div>;
  return <form className="composer-wrap" onSubmit={submit}>
    {error && <Notice text={error} compact />}
    <div className="composer">
      {quote && <div className="quote-draft"><div><strong>回复 {quotedSender}</strong><span>{quote.content}</span></div><button type="button" className="icon-button" onClick={() => setQuote(null)} aria-label="取消引用"><Icon name="close" /></button></div>}
      <div ref={menuRef} id={listId} className={`mention-menu ${query ? 'mention-menu--open' : 'mention-menu--closed'}`} role="listbox" aria-label="可提及的 Agent" aria-hidden={!query}>
        <div className="mention-menu-title" aria-hidden="true">选择要提及的 Agent</div>
        {shownCandidates.map((agent, index) => <div id={`${listId}-${agent.participant_id}`} key={agent.participant_id} role="option" aria-label={agents.filter((other) => other.name === agent.name).length > 1 ? `${agent.name} #${agent.participant_id}` : agent.name} aria-selected={index === Math.min(activeIndex, shownCandidates.length - 1)} className={`mention-option ${index === Math.min(activeIndex, shownCandidates.length - 1) ? 'is-active' : ''}`} onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(agent)}>
          <span>{agent.name}</span>{agents.filter((other) => other.name === agent.name).length > 1 && <small>#{agent.participant_id}</small>}
        </div>)}
        {!shownCandidates.length && <div className="mention-empty">没有匹配的 Agent</div>}
      </div>
      <div className="composer-editor">
        <div className="composer-mirror" aria-hidden="true" ref={mirrorRef}>{highlighted}{'\u200b'}</div>
      <textarea
        ref={textareaRef}
        aria-label="消息内容"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={query ? listId : undefined}
        aria-activedescendant={query && active ? `${listId}-${active.participant_id}` : undefined}
        placeholder="写下你的消息…"
        value={draft.text}
        onChange={(event) => change(event.currentTarget)}
        onScroll={(event) => { if (mirrorRef.current) { mirrorRef.current.scrollTop = event.currentTarget.scrollTop; mirrorRef.current.scrollLeft = event.currentTarget.scrollLeft; } }}
        onBeforeInput={(event) => rememberSelection(event.currentTarget)}
        onPaste={(event) => rememberSelection(event.currentTarget)}
        onCut={(event) => rememberSelection(event.currentTarget)}
        onSelect={(event) => { const selection = selectionOf(event.currentTarget); selectionRef.current = selection; updateQuery(draftRef.current, selection); }}
        onBlur={closeQuery}
        disabled={sending}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          rememberSelection(event.currentTarget);
          // Some browsers report composition end before the confirming keydown.
          if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (query && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && candidates.length) {
            event.preventDefault();
            setActiveIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length);
            return;
          }
          if (query && event.key === 'Escape') { event.preventDefault(); closeQuery(); return; }
          if (event.key !== 'Enter' || event.shiftKey) return;
          event.preventDefault();
          if (event.repeat) return;
          if (query) { if (active) choose(active); return; }
          event.currentTarget.form?.requestSubmit();
        }}
      />
      </div>
      <div className="composer-toolbar"><button type="submit" className="send-button" disabled={!draft.text.trim() || sending}>{sending ? '发送中' : '发送'} <Icon name="send" /></button></div>
    </div>
  </form>;
}
