import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { Conversation, Message, Participant } from '../../api/types';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Notice } from '../../components/Notice';
import { conversationName } from '../conversations/labels';
import { Composer } from './Composer';
import { MembersPanel } from './MembersPanel';
import { MessageList } from './MessageList';
import { useMessages } from './useMessages';

export function ChatView({ active, currentUser, conversation, participants, onConversationChange, onMembersLoaded, onBack }: { active: boolean; currentUser: Participant; conversation: Conversation; participants: Participant[]; onConversationChange: (conversation: Conversation) => void; onMembersLoaded: (id: number, members: Participant[]) => void; onBack: () => void }) {
  const [members, setMembers] = useState<Participant[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState('');
  const [memberVersion, setMemberVersion] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [quote, setQuote] = useState<Message | null>(null);
  const [conversationError, setConversationError] = useState('');
  const [conversationVersion, setConversationVersion] = useState(0);
  const state = useMessages(conversation.conversation_id, active);
  const updateMembers = useCallback((list: Participant[]) => { setMembers(list); onMembersLoaded(conversation.conversation_id, list); }, [conversation.conversation_id, onMembersLoaded]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); setMembersLoading(true); setMembersError('');
    void api.members(conversation.conversation_id, controller.signal).then((list) => { if (!controller.signal.aborted) updateMembers(list); }).catch((error: unknown) => { if (!controller.signal.aborted) setMembersError(errorMessage(error)); }).finally(() => { if (!controller.signal.aborted) setMembersLoading(false); });
    return () => controller.abort();
  }, [conversation.conversation_id, updateMembers, memberVersion, active]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void api.getConversation(conversation.conversation_id, controller.signal).then((result) => { if (!controller.signal.aborted) { onConversationChange(result); setConversationError(''); } }).catch((error: unknown) => { if (!controller.signal.aborted) setConversationError(errorMessage(error)); });
    return () => controller.abort();
  }, [conversation.conversation_id, onConversationChange, conversationVersion, active]);
  const currentMembers = members.map((member) => participants.find((person) => person.participant_id === member.participant_id) ?? member);
  const name = conversationName(conversation, currentMembers);
  const dissolved = conversation.dissolved_at !== null;
  return <main className="chat-area" aria-label="聊天窗口">
    <div className="chat-main"><header className="chat-header"><button className="icon-button mobile-back" onClick={onBack} aria-label="返回列表"><Icon name="arrowLeft" /></button><Avatar name={name} id={conversation.conversation_id} group={conversation.kind === 'group'} size="small" /><div className="chat-heading"><h2>{name}</h2><p>{conversation.kind === 'group' ? '群聊' : '单聊'}{membersLoading || membersError ? '' : ` · ${members.length} 位成员`}{dissolved ? ' · 已解散' : ''}</p></div><button className={`header-more ${showDetails ? 'is-active' : ''}`} onClick={() => setShowDetails(!showDetails)} aria-label="查看会话详情" aria-expanded={showDetails}><Icon name="more" /></button></header>
      {membersError && <Notice text={`成员加载失败：${membersError}`} onRetry={() => setMemberVersion((v) => v + 1)} compact />}
      {conversationError && <Notice text={conversationError} onRetry={() => setConversationVersion((v) => v + 1)} compact />}
      {state.syncError && <div className="sync-banner"><Notice text={`消息同步失败：${state.syncError}`} onRetry={state.retrySync} compact /></div>}
      {state.hasNewer && <div className="sync-status" role="status">正在同步更多新消息…</div>}
      {state.loading ? <div className="center-state"><div className="spinner" /><span>正在加载消息…</span></div> : state.loadError ? <div className="center-state"><span className="empty-orb"><Icon name="refresh" /></span><strong>无法加载消息</strong><p>{state.loadError}</p><button className="button button--light" onClick={state.retryLoad}>重试</button></div> : <MessageList currentUser={currentUser} messages={state.messages} participants={participants} hasOlder={state.hasOlder} loadingOlder={state.loadingOlder} olderError={state.olderError} onOlder={state.loadOlder} onQuote={setQuote} canQuote={!dissolved} />}
      {!state.loading && !state.loadError && <Composer conversationId={conversation.conversation_id} group={conversation.kind === 'group'} members={currentMembers} participants={participants} quote={quote} setQuote={setQuote} onSent={(message) => state.addMessage([message])} disabled={dissolved} />}
    </div>
    {showDetails && <MembersPanel conversation={conversation} members={currentMembers} participants={participants} loading={membersLoading} error={membersError} onRetry={() => setMemberVersion((v) => v + 1)} onMembersChange={updateMembers} onConversationChange={onConversationChange} onClose={() => setShowDetails(false)} />}
  </main>;
}
