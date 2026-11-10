import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../../api/client';
import type { AgentAccount, CreateAgentInput, Participant, UpdateAgentInput } from '../../api/types';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Notice } from '../../components/Notice';
import { AgentEditor } from './AgentEditor';

export function AgentManager({ user, active, onClose, onChanged }: { user: Participant; active: boolean; onClose: () => void; onChanged: (agent: AgentAccount) => void }) {
  const [agents, setAgents] = useState<AgentAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<AgentAccount | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const createRef = useRef<HTMLButtonElement>(null);
  const returningToList = useRef(false);
  const alive = useRef(true);
  const activeRef = useRef(active); activeRef.current = active;
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    if (!editing && returningToList.current) { createRef.current?.focus(); returningToList.current = false; }
  }, [editing]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); setLoading(true); setError('');
    void api.agents(controller.signal).then((result) => {
      if (!controller.signal.aborted) setAgents(result.filter((agent) => agent.owner_participant_id === user.participant_id));
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, user.participant_id, version]);
  const save = async (input: CreateAgentInput | UpdateAgentInput) => {
    const result = editing === 'new'
      ? await api.createAgent(input as CreateAgentInput)
      : editing ? await api.updateAgent(editing.participant_id, input) : null;
    if (!result || result.owner_participant_id !== user.participant_id) throw new ApiError('服务返回的 Agent 归属不正确。', 'INVALID_RESPONSE');
    if (!alive.current || !activeRef.current) return;
    setAgents((current) => current.some((item) => item.participant_id === result.participant_id)
      ? current.map((item) => item.participant_id === result.participant_id ? result : item) : [...current, result]);
    onChanged(result); returningToList.current = true; setEditing(null);
  };
  return <Modal title={editing === 'new' ? '创建 Agent' : editing ? '编辑 Agent' : '我的 Agent'} onClose={() => { if (!savingRef.current) onClose(); }}>
    {saving && <span className="sr-only" role="status">正在保存</span>}
    {editing ? <AgentEditor key={editing === 'new' ? 'new' : editing.participant_id} agent={editing === 'new' ? null : editing} onCancel={() => { returningToList.current = true; setEditing(null); }} onSave={save} onBusyChange={(busy) => { savingRef.current = busy; setSaving(busy); }} /> : <>
      <div className="agent-list-heading"><p>管理你创建的 Agent 及其登录账号。</p><button ref={createRef} className="button button--light" onClick={() => setEditing('new')} disabled={loading || !!error}><Icon name="plus" /> 创建 Agent</button></div>
      {loading ? <p className="agent-state" role="status">正在加载 Agent…</p> : error ? <Notice text={error} onRetry={() => setVersion((value) => value + 1)} compact /> : agents.length ? <div className="agent-account-list">{agents.map((agent) => <div className="agent-account-row" key={agent.participant_id}>
        <Avatar name={agent.name} id={agent.participant_id} size="small" /><div className="agent-account-copy"><strong>{agent.name}</strong><span>{agent.username}</span></div><button className="text-button" aria-label={`编辑 ${agent.name}（${agent.username}）`} onClick={() => setEditing(agent)}>编辑</button>
      </div>)}</div> : <p className="agent-state">还没有 Agent，创建后即可在通讯录中发起对话。</p>}
    </>}
  </Modal>;
}
