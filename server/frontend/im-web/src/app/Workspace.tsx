import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import type { AgentAccount, Conversation, Participant } from '../api/types';
import { Icon } from '../components/Icon';
import { AgentManager } from '../features/agents/AgentManager';
import { ChatView } from '../features/chat/ChatView';
import { CreateGroupDialog } from '../features/conversations/CreateGroupDialog';
import { Sidebar, type Section } from '../features/conversations/Sidebar';

export function Workspace({ user, active, onLogout }: { user: Participant; active: boolean; onLogout: () => void }) {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [membersByConversation, setMembersByConversation] = useState<Record<string, Participant[]>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('chats');
  const [mobileChat, setMobileChat] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [managingAgents, setManagingAgents] = useState(false);
  const [busyAgent, setBusyAgent] = useState<string | null>(null);
  const [contactError, setContactError] = useState('');
  const [busyConversation, setBusyConversation] = useState<string | null>(null);
  const [conversationError, setConversationError] = useState('');
  const initialized = useRef(false);
  useEffect(() => {
    if (!active || initialized.current) return;
    const controller = new AbortController(); setLoading(true); setLoadError('');
    void Promise.all([api.participants(controller.signal), api.conversations(controller.signal)]).then(([people, chats]) => {
      if (controller.signal.aborted) return;
      initialized.current = true; setParticipants(people); setConversations(chats);
      setSelectedId((previous) => previous && chats.some((chat) => chat.conversation_id === previous && !chat.hidden) ? previous : chats.find((chat) => !chat.hidden)?.conversation_id ?? null);
      setLoading(false);
    }).catch((error: unknown) => { if (!controller.signal.aborted) { setLoadError(errorMessage(error)); setLoading(false); } });
    return () => controller.abort();
  }, [version, active]);
  useEffect(() => { if (!active) setManagingAgents(false); }, [active]);
  useEffect(() => {
    if (selectedId && !conversations.some((chat) => chat.conversation_id === selectedId && !chat.hidden)) {
      const next = conversations.find((chat) => !chat.hidden);
      setSelectedId(next?.conversation_id ?? null);
      if (!next) setMobileChat(false);
    }
  }, [conversations, selectedId]);
  const agentChanged = useCallback((agent: AgentAccount) => {
    const participant: Participant = { participant_id: agent.participant_id, kind: 'agent', name: agent.name, created_at: agent.created_at };
    setParticipants((current) => current.some((item) => item.participant_id === participant.participant_id)
      ? current.map((item) => item.participant_id === participant.participant_id ? participant : item) : [...current, participant]);
  }, []);
  const upsert = useCallback((conversation: Conversation) => setConversations((current) => {
    const found = current.some((item) => item.conversation_id === conversation.conversation_id);
    return found ? current.map((item) => item.conversation_id === conversation.conversation_id ? conversation : item) : [conversation, ...current];
  }), []);
  // A details read started before a visibility change must not undo that change.
  const updateDetails = useCallback((conversation: Conversation) => setConversations((current) => current.map((item) =>
    item.conversation_id === conversation.conversation_id ? { ...conversation, hidden: item.hidden } : item)), []);
  const membersLoaded = useCallback((id: string, members: Participant[]) => setMembersByConversation((current) => ({ ...current, [id]: members })), []);
  const select = (id: string) => { setSelectedId(id); setSection('chats'); setMobileChat(true); };
  const openDirect = async (agent: Participant) => {
    if (busyAgent !== null) return;
    setBusyAgent(agent.participant_id); setContactError('');
    try { const conversation = await api.openDirect(agent.participant_id); upsert(conversation); membersLoaded(conversation.conversation_id, [agent]); select(conversation.conversation_id); }
    catch (error) { setContactError(errorMessage(error)); }
    finally { setBusyAgent(null); }
  };
  const createGroup = async (title: string, ids: string[]) => { const conversation = await api.createGroup(title, ids); upsert(conversation); select(conversation.conversation_id); };
  const changeVisibility = async (conversation: Conversation, hidden: boolean) => {
    if (busyConversation !== null) return;
    setBusyConversation(conversation.conversation_id); setConversationError('');
    try {
      const updated = await api.setVisibility(conversation.conversation_id, hidden);
      upsert(updated);
      if (!hidden) select(updated.conversation_id);
    } catch (error) { setConversationError(errorMessage(error)); }
    finally { setBusyConversation(null); }
  };
  const selected = conversations.find((conversation) => conversation.conversation_id === selectedId && !conversation.hidden);
  if (loading || loadError) return <div className="connection-screen"><div className="connection-card"><div className="brand-mark">s<span>·</span></div>{loading ? <><div className="spinner" /><h1>正在连接对话空间</h1><p>正在获取会话与通讯录…</p></> : <><span className="empty-orb"><Icon name="refresh" /></span><h1>暂时无法连接</h1><p>{loadError}</p><button className="button button--primary" onClick={() => setVersion((value) => value + 1)}>重新连接</button></>}</div></div>;
  return <div className={`workspace ${mobileChat ? 'workspace--mobile-chat' : ''}`}>
    {import.meta.env.VITE_IM_DEMO === 'true' && <div className="demo-banner" role="status">演示预览 · 以下为示例数据，不连接真实业务</div>}
    <div className="workspace-layout">
      <Sidebar user={user} onLogout={onLogout} section={section} setSection={(next) => { setSection(next); setMobileChat(false); }} conversations={conversations} participants={participants} membersByConversation={membersByConversation} selectedId={selectedId} onSelect={select} onCreate={() => setCreating(true)} onManageAgents={() => setManagingAgents(true)} onOpenDirect={openDirect} busyAgent={busyAgent} contactError={contactError} onOpenGroup={(conversation) => void changeVisibility(conversation, false)} onHide={(conversation) => void changeVisibility(conversation, true)} busyConversation={busyConversation} conversationError={conversationError} />
      {selected ? <ChatView key={selected.conversation_id} active={active} currentUser={user} conversation={selected} participants={participants} onConversationChange={updateDetails} onMembersLoaded={membersLoaded} onBack={() => setMobileChat(false)} /> : <main className="chat-area chat-placeholder"><span className="empty-orb"><Icon name="sparkle" /></span><h2>你好，开始对话吧</h2><p>从通讯录选择一位 Agent，或从群聊列表打开一个群。</p><button className="button button--primary" onClick={() => setSection('contacts')}>打开通讯录</button></main>}
    </div>
    {managingAgents && user.kind === 'human' && <AgentManager user={user} active={active} onClose={() => setManagingAgents(false)} onChanged={agentChanged} />}
    {creating && <CreateGroupDialog agents={participants.filter((p) => p.kind === 'agent')} onClose={() => setCreating(false)} onCreate={createGroup} />}
  </div>;
}
