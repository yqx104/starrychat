import { useState, type FormEvent } from 'react';
import type { Participant } from '../../api/types';
import { Avatar } from '../../components/Avatar';
import { Modal } from '../../components/Modal';
import { Notice } from '../../components/Notice';

export function CreateGroupDialog({ agents, onClose, onCreate }: { agents: Participant[]; onClose: () => void; onCreate: (title: string, ids: string[]) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!title.trim() || busy) return;
    setBusy(true); setError('');
    try { await onCreate(title, ids); onClose(); } catch (e) { setError(e instanceof Error ? e.message : '创建失败，请重试。'); } finally { setBusy(false); }
  };
  return <Modal title="创建群聊" onClose={onClose}>
    <form onSubmit={submit}>
      <p className="modal-description">给群聊起个名字，邀请 Agent 一起协作。</p>
      <label className="field-label" htmlFor="group-title">群聊名称</label>
      <input id="group-title" className="text-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：产品讨论组" />
      <div className="field-label field-label--spaced">选择 Agent <span>已选 {ids.length}</span></div>
      <div className="selection-list">{agents.map((agent) => <label className="selection-row" key={agent.participant_id}><Avatar name={agent.name} id={agent.participant_id} size="small" /><span>{agent.name}</span><input type="checkbox" checked={ids.includes(agent.participant_id)} onChange={(event) => setIds(event.target.checked ? [...ids, agent.participant_id] : ids.filter((id) => id !== agent.participant_id))} /></label>)}{!agents.length && <p className="muted">暂无可邀请的 Agent</p>}</div>
      {error && <Notice text={error} compact />}
      <div className="modal-actions"><button type="button" className="button button--light" onClick={onClose}>取消</button><button className="button button--primary" disabled={!title.trim() || busy}>{busy ? '创建中…' : '创建群聊'}</button></div>
    </form>
  </Modal>;
}
