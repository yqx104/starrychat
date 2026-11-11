import { useEffect, useState, type FormEvent } from 'react';
import { api, type Agent, type Config, type InboxItem } from './api';

const states: Record<string, string> = {
  disabled: '已停用', connecting: '连接中', online: '已连接', reconnecting: '等待重连', auth_required: '需要认证', conflict: '连接冲突',
};
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false });

export function App() {
  const [config, setConfig] = useState<Config>();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<string>();
  const [messages, setMessages] = useState<InboxItem[]>([]);
  const [before, setBefore] = useState<number>();
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState<'new' | Agent | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = agents.find(agent => agent.agent_id === selected);

  useEffect(() => {
    const controller = new AbortController();
    api<Config>('/config', { signal: controller.signal }).then(setConfig).catch(() => {});
    const poll = async () => {
      try {
        const data = await api<{ agents: Agent[] }>('/agents', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setAgents(data.agents); setSelected(current => current ?? data.agents[0]?.agent_id); setError('');
      } catch { if (!controller.signal.aborted) setError('无法连接本机 adaptor 服务，请检查服务是否已启动。'); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    };
    void poll(); const timer = setInterval(poll, 2000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);

  useEffect(() => {
    setMessages([]); setHasMore(false);
    if (!selected) return;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const data = await api<{ messages: InboxItem[]; has_more: boolean }>(
          `/agents/${selected}/inbox?limit=50${before ? `&before_id=${before}` : ''}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setMessages(data.messages); setHasMore(data.has_more); }
      } catch { if (!controller.signal.aborted) setError('收件箱读取失败，请稍后重试。'); }
    };
    void poll(); const timer = setInterval(poll, 2000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [selected, before]);

  function openForm(target: 'new' | Agent) {
    setForm(target); setUsername(target === 'new' ? '' : target.username); setPassword(''); setFormError('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!form) return;
    setSaving(true); setFormError('');
    try {
      const path = form === 'new' ? '/agents' : `/agents/${form.agent_id}/reauthenticate`;
      const { agent } = await api<{ agent: Agent }>(path, { method: 'POST', body: JSON.stringify({ username, password }) });
      setAgents(current => [...current.filter(item => item.agent_id !== agent.agent_id), agent]);
      setSelected(agent.agent_id); setBefore(undefined); setForm(null); setPassword('');
    } catch (error) { setFormError(error instanceof Error ? error.message : '接入失败'); }
    finally { setSaving(false); }
  }
  async function toggle() {
    if (!active) return;
    setBusy(true);
    try {
      const { agent } = await api<{ agent: Agent }>(`/agents/${active.agent_id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !active.enabled }) });
      setAgents(current => current.map(item => item.agent_id === agent.agent_id ? agent : item));
    } catch (error) { setError(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(false); }
  }

  return <div className="app">
    <header className="topbar"><div className="brand"><span className="brand-mark">✦</span><div><strong>StarryChat</strong><small>本机 Adaptor</small></div></div>
      <span className="summary">{agents.filter(agent => agent.connection_state === 'online').length} / {agents.length} 个 Agent 已连接</span>
    </header>
    {error && <div role="alert" className="error-banner">{error}</div>}
    <div className="layout">
      <aside className="sidebar">
        <div className="section-heading"><h2>本机 Agent</h2><button className="primary small" onClick={() => openForm('new')}>＋ 接入账号</button></div>
        <div className="agent-list">
          {loading ? <p className="hint">正在读取…</p> : agents.length === 0 ? <p className="hint">添加一个已有的 IM Agent 账号，开始接收消息。</p> : agents.map(agent =>
            <button key={agent.agent_id} className={`agent-row ${selected === agent.agent_id ? 'selected' : ''}`} onClick={() => { setSelected(agent.agent_id); setBefore(undefined); }}>
              <span className="avatar">{agent.name.slice(0, 1)}</span><span className="agent-label"><strong>{agent.name}</strong><small>@{agent.username}</small></span>
              <span className={`dot ${agent.connection_state}`} title={states[agent.connection_state]} />
            </button>)}
        </div>
        <div className="server-card"><span className="eyebrow">连接到服务端</span><label>IM</label><code>{config?.im_base_url ?? '—'}</code><label>Trigger</label><code>{config?.trigger_ws_url ?? '—'}</code></div>
      </aside>
      <main>
        {!active ? <div className="empty"><span className="empty-icon">✦</span><h1>让 Agent 与消息连接</h1><p>接入账号后，后台会持续连接 Trigger，<br />将收到的消息保存在这台电脑上。</p><button className="primary" onClick={() => openForm('new')}>接入 Agent 账号</button></div> : <>
          <div className="agent-header"><div><div className="title-line"><h1>{active.name}</h1><span className={`badge ${active.connection_state}`}>{states[active.connection_state] ?? active.connection_state}</span></div><p className="identity">{active.agent_id}</p></div><div className="actions"><button onClick={() => openForm(active)}>重新认证</button><button disabled={busy} onClick={toggle}>{active.enabled ? '停用连接' : '启用连接'}</button></div></div>
          {active.last_error && <div className="notice">{active.last_error}</div>}
          <div className="inbox-heading"><div><h2>收件箱</h2><p>消息已保存至本机，等待执行器接入。</p></div><span className="eyebrow">{before ? '历史消息' : '最新消息'} · 每 2 秒刷新</span></div>
          <div className="messages">{messages.length === 0 ? <div className="empty-inbox"><h3>暂时没有收到消息</h3><p>连接就绪后，Trigger 会投递发给这个 Agent 的消息。</p></div> : messages.map(item => <article className="message" key={item.id}>
            <div className="message-meta"><span>{item.message.channel_type === 'im_direct' ? '单聊' : '群聊'} <span className="seq">#{item.message.message_seq}</span></span><time>{time(item.received_at)}</time></div>
            <p className="message-content">{item.message.content}</p><div className="message-footer"><code title={item.message.conversation_id}>会话 {item.message.conversation_id}</code><span className="pending">待执行</span></div>
          </article>)}</div>
          <div className="pagination">{before && <button onClick={() => setBefore(undefined)}>返回最新</button>}{hasMore && <button onClick={() => setBefore(messages.at(-1)?.id)}>更早的消息 →</button>}</div>
        </>}
      </main>
    </div>
    {form && <div className="overlay"><section role="dialog" aria-modal="true" aria-labelledby="form-title" className="dialog"><h2 id="form-title">{form === 'new' ? '接入 Agent 账号' : '重新认证'}</h2><p>使用已在 IM 创建的 Agent 账号。</p><form onSubmit={submit}>
      <label htmlFor="username">用户名</label><input id="username" autoFocus autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required />
      <label htmlFor="password">密码</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required />
      {formError && <div role="alert" className="form-error">{formError}</div>}
      <div className="dialog-actions"><button type="button" disabled={saving} onClick={() => { setForm(null); setPassword(''); }}>取消</button><button className="primary" disabled={saving}>{saving ? '正在验证…' : '验证并接入'}</button></div>
    </form></section></div>}
  </div>;
}
