import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../../api/client';
import type { Conversation, Participant } from '../../api/types';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Notice } from '../../components/Notice';
import { conversationName } from '../conversations/labels';

export function MembersPanel({ conversation, members, participants, loading, error, onRetry, onMembersChange, onConversationChange, onClose }: {
  conversation: Conversation; members: Participant[]; participants: Participant[]; loading: boolean; error: string; onRetry: () => void;
  onMembersChange: (members: Participant[]) => void; onConversationChange: (conversation: Conversation) => void; onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation.title ?? '');
  const [candidate, setCandidate] = useState('');
  const [pending, setPending] = useState(false);
  const [operationError, setOperationError] = useState('');
  const [confirmation, setConfirmation] = useState<{ kind: 'remove'; member: Participant } | { kind: 'dissolve' } | null>(null);
  const isGroup = conversation.kind === 'group';
  const editable = isGroup && conversation.dissolved_at === null;
  const available = participants.filter((p) => p.kind === 'agent' && !members.some((member) => member.participant_id === p.participant_id));
  const run = async (operation: () => Promise<void>) => {
    if (pending) return;
    setPending(true); setOperationError('');
    try { await operation(); } catch (e) { setOperationError(errorMessage(e)); } finally { setPending(false); }
  };
  const rename = (event: FormEvent) => {
    event.preventDefault(); if (!title.trim()) return;
    void run(async () => { onConversationChange(await api.rename(conversation.conversation_id, title)); setEditing(false); });
  };
  const add = () => {
    const id = Number(candidate); if (!id) return;
    void run(async () => { const member = await api.addMember(conversation.conversation_id, id); onMembersChange([...members, member]); setCandidate(''); });
  };
  const confirm = () => {
    if (!confirmation) return;
    void run(async () => {
      if (confirmation.kind === 'remove') { await api.removeMember(conversation.conversation_id, confirmation.member.participant_id); onMembersChange(members.filter((member) => member.participant_id !== confirmation.member.participant_id)); }
      else onConversationChange(await api.dissolve(conversation.conversation_id));
      setConfirmation(null);
    });
  };
  return <aside className="detail-panel" aria-label={isGroup ? '群聊详情' : '会话详情'}>
    <div className="detail-heading"><h2>会话详情</h2><button className="icon-button" onClick={onClose} aria-label="关闭会话详情"><Icon name="close" /></button></div>
    <div className="detail-profile"><Avatar name={conversationName(conversation, members)} id={conversation.conversation_id} group={isGroup} size="large" /><h3>{conversationName(conversation, members)}</h3><p>{isGroup ? '群聊' : '单聊'} · #{conversation.conversation_id}{conversation.dissolved_at !== null ? ' · 已解散' : ''}</p></div>
    {isGroup && <div className="detail-section"><div className="detail-label">群聊名称 {editable && !editing && <button className="text-button" onClick={() => { setTitle(conversation.title ?? ''); setEditing(true); }}>编辑</button>}</div>
      {editing && editable ? <form className="rename-form" onSubmit={rename}><input className="text-input" aria-label="群聊名称" value={title} onChange={(event) => setTitle(event.target.value)} /><div><button className="text-button" type="button" onClick={() => setEditing(false)}>取消</button><button className="text-button" disabled={!title.trim() || pending}>保存</button></div></form> : <div className="detail-value">{conversation.title || '未命名'}</div>}
    </div>}
    <div className="detail-section"><div className="detail-label">成员 <span>{loading ? '…' : members.length}</span></div>
      {loading && <p className="muted">正在加载成员…</p>}
      {error && <Notice text={error} onRetry={onRetry} compact />}
      {!loading && !error && <div className="member-list">{members.map((member) => <div className="member-row" key={member.participant_id}><Avatar name={member.name} id={member.participant_id} size="small" /><div><strong>{member.name}</strong><span>{member.kind === 'human' ? '成员' : 'Agent'}</span></div>{editable && member.kind === 'agent' && <button className="member-remove" onClick={() => setConfirmation({ kind: 'remove', member })} aria-label={`移除 ${member.name}`} disabled={pending}>移除</button>}</div>)}</div>}
      {editable && !loading && !error && <div className="add-member"><label className="sr-only" htmlFor="add-member">选择要加入的 Agent</label><select id="add-member" value={candidate} onChange={(event) => setCandidate(event.target.value)} disabled={pending || !available.length}><option value="">{available.length ? '选择 Agent' : '没有可加入的 Agent'}</option>{available.map((p) => <option value={p.participant_id} key={p.participant_id}>{p.name}</option>)}</select><button className="button button--light" onClick={add} disabled={!candidate || pending}>加入</button></div>}
    </div>
    {operationError && <Notice text={operationError} compact />}
    {editable && <div className="detail-danger"><button onClick={() => setConfirmation({ kind: 'dissolve' })} disabled={pending}>解散群聊</button><p>解散后仍可查看历史消息</p></div>}
    {confirmation && <Modal title={confirmation.kind === 'remove' ? '移除成员' : '解散群聊'} onClose={() => { if (!pending) setConfirmation(null); }}>
      <p className="modal-description">{confirmation.kind === 'remove' ? `确定将 ${confirmation.member.name} 移出群聊吗？` : '确定解散这个群聊吗？解散后不能发送消息或修改成员，历史消息会保留。'}</p>
      {operationError && <Notice text={operationError} compact />}
      <div className="modal-actions"><button className="button button--light" onClick={() => setConfirmation(null)} disabled={pending}>取消</button><button className="button button--danger" onClick={confirm} disabled={pending}>{pending ? '处理中…' : confirmation.kind === 'remove' ? '确认移除' : '确认解散'}</button></div>
    </Modal>}
  </aside>;
}
