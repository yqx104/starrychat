import { useState } from 'react';
import type { Conversation, Participant } from '../../api/types';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { conversationName } from './labels';

export type Section = 'chats' | 'contacts';
export function Sidebar({ user, onLogout, section, setSection, conversations, participants, membersByConversation, selectedId, onSelect, onCreate, onManageAgents, onOpenDirect, busyAgent, contactError }: {
  user: Participant; onLogout: () => void; section: Section; setSection: (section: Section) => void; conversations: Conversation[]; participants: Participant[];
  membersByConversation: Record<string, Participant[]>; selectedId: string | null; onSelect: (id: string) => void; onCreate: () => void; onManageAgents: () => void;
  onOpenDirect: (agent: Participant) => void; busyAgent: string | null; contactError: string;
}) {
  const [search, setSearch] = useState('');
  const agents = participants.filter((p) => p.kind === 'agent');
  const matches = (text: string) => text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const currentMembers = (id: string) => membersByConversation[id]?.map((member) => participants.find((person) => person.participant_id === member.participant_id) ?? member);
  const visibleConversations = [...conversations].sort((a, b) => b.created_at - a.created_at || b.conversation_id.localeCompare(a.conversation_id)).filter((c) => matches(conversationName(c, currentMembers(c.conversation_id))));
  const visibleAgents = agents.filter((p) => matches(p.name));
  return <>
    <nav className="rail" aria-label="主导航">
      <div className="brand-mark" aria-label="starrychat">s<span>·</span></div>
      <div className="rail-nav">
        <button className={`rail-button ${section === 'chats' ? 'is-active' : ''}`} onClick={() => { setSection('chats'); setSearch(''); }} aria-label="消息" aria-current={section === 'chats' ? 'page' : undefined}><Icon name="chat" /><span>消息</span></button>
        <button className={`rail-button ${section === 'contacts' ? 'is-active' : ''}`} onClick={() => { setSection('contacts'); setSearch(''); }} aria-label="通讯录" aria-current={section === 'contacts' ? 'page' : undefined}><Icon name="users" /><span>通讯录</span></button>
      </div>
      <div className="rail-bottom"><div title={user.name}><Avatar name={user.name} id={user.participant_id} size="small" /></div><button className="rail-logout" onClick={onLogout} aria-label="退出登录" title="退出登录"><Icon name="logout" /></button></div>
    </nav>
    <aside className="sidebar" aria-label={section === 'chats' ? '会话列表' : '通讯录'}>
      <div className="sidebar-top"><div><div className="eyebrow">WORKSPACE <span> / </span> starrychat</div><h1>{section === 'chats' ? '消息' : '通讯录'}</h1><p>{section === 'chats' ? '与团队保持同步' : '找到你的 Agent 伙伴'}</p></div>
        {section === 'chats' && <button className="square-button" onClick={onCreate} aria-label="创建群聊" title="创建群聊"><Icon name="plus" /></button>}
      </div>
      <label className="search-box"><Icon name="search" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={section === 'chats' ? '搜索会话' : '搜索 Agent'} aria-label={section === 'chats' ? '搜索会话' : '搜索 Agent'} /></label>
      {section === 'contacts' && user.kind === 'human' && <button className="manage-agent-entry" onClick={onManageAgents}><Icon name="settings" /><span>管理我的 Agent</span><span aria-hidden="true">›</span></button>}
      <div className="list-label"><span>{section === 'chats' ? '全部会话' : '已注册的 Agent'}</span><span>{section === 'chats' ? visibleConversations.length : visibleAgents.length}</span></div>
      <div className="sidebar-list">
        {section === 'chats' ? visibleConversations.map((conversation) => {
          const name = conversationName(conversation, currentMembers(conversation.conversation_id));
          return <button key={conversation.conversation_id} className={`conversation-item ${selectedId === conversation.conversation_id ? 'is-selected' : ''}`} onClick={() => onSelect(conversation.conversation_id)} aria-current={selectedId === conversation.conversation_id ? 'true' : undefined}>
            <Avatar name={name} id={conversation.conversation_id} group={conversation.kind === 'group'} />
            <span className="conversation-copy"><strong>{name}</strong><span>{conversation.kind === 'group' ? '群聊' : '单聊'}{conversation.dissolved_at !== null ? ' · 已解散' : ` · #${conversation.conversation_id}`}</span></span>
            <span className="item-arrow">›</span>
          </button>;
        }) : visibleAgents.map((agent) => <button key={agent.participant_id} className="conversation-item contact-item" onClick={() => onOpenDirect(agent)} disabled={busyAgent !== null}>
          <Avatar name={agent.name} id={agent.participant_id} /><span className="conversation-copy"><strong>{agent.name}</strong><span>{busyAgent === agent.participant_id ? '正在打开…' : 'Agent · 点击发起对话'}</span></span><span className="item-arrow">›</span>
        </button>)}
        {section === 'chats' && !visibleConversations.length && <div className="sidebar-empty">{search ? '没有找到匹配的会话' : '还没有会话，去通讯录发起对话吧'}</div>}
        {section === 'contacts' && !visibleAgents.length && <div className="sidebar-empty">{search ? '没有找到匹配的 Agent' : '暂无已注册的 Agent'}</div>}
        {section === 'contacts' && contactError && <div className="inline-error" role="alert">{contactError}</div>}
      </div>
      <div className="sidebar-footer"><span className="footer-dot" /> 你的对话空间 <span className="footer-version">IM / 01</span></div>
    </aside>
  </>;
}
