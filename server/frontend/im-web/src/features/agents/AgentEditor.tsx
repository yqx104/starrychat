import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, errorMessage } from '../../api/client';
import type { AgentAccount, CreateAgentInput, UpdateAgentInput } from '../../api/types';
import { Notice } from '../../components/Notice';
import { validateCredentials, validateName, validatePassword, validateUsername } from '../auth/validation';

export function AgentEditor({ agent, onCancel, onSave, onBusyChange }: {
  agent: AgentAccount | null;
  onCancel: () => void;
  onSave: (input: CreateAgentInput | UpdateAgentInput) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); }, []);
  const [name, setName] = useState(agent?.name ?? '');
  const [username, setUsername] = useState(agent?.username ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busyRef.current) return;
    const validation = agent
      ? validateName(name) ?? validateUsername(username) ?? (password ? validatePassword(password) : null)
      : validateCredentials(username, password, name);
    if (validation) { setError(validation); return; }
    const input: CreateAgentInput | UpdateAgentInput = agent ? {
      ...(name !== agent.name ? { name } : {}),
      ...(username !== agent.username ? { username } : {}),
      ...(password ? { password } : {}),
    } : { name, username, password };
    if (!Object.keys(input).length) { setError('资料没有变化。'); return; }
    busyRef.current = true; setBusy(true); onBusyChange(true); setError('');
    try { await onSave(input); setPassword(''); }
    catch (reason) {
      setError(reason instanceof ApiError && reason.status === 409 ? '该登录账号已被使用，请换一个账号。' : errorMessage(reason));
    } finally { busyRef.current = false; setBusy(false); onBusyChange(false); }
  };
  return <form onSubmit={submit} autoComplete="off">
    <p className="modal-description">{agent ? '修改 Agent 资料；新密码留空时保持原密码。' : '为 Agent 设置名称和独立的登录账号。'}</p>
    <label className="field-label" htmlFor="agent-name">Agent 名称</label>
    <input ref={nameRef} id="agent-name" className="text-input" value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
    <label className="field-label agent-field" htmlFor="agent-username">登录账号</label>
    <input id="agent-username" className="text-input" autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} disabled={busy} />
    <label className="field-label agent-field" htmlFor="agent-password">{agent ? '新密码（可留空）' : '密码'}</label>
    <input id="agent-password" className="text-input" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
    {error && <Notice text={error} compact />}
    <div className="modal-actions"><button type="button" className="button button--light" disabled={busy} onClick={() => { setPassword(''); onCancel(); }}>返回</button><button className="button button--primary" disabled={busy}>{busy ? '保存中…' : agent ? '保存修改' : '创建 Agent'}</button></div>
  </form>;
}
