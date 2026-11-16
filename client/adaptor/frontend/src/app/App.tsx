import { useState } from 'react';
import type { Agent } from '../api/types';
import { AgentConnectDialog } from '../features/agents/AgentConnectDialog';
import { AgentHeader } from '../features/agents/AgentHeader';
import { AgentList } from '../features/agents/AgentList';
import { useAgents } from '../features/agents/useAgents';
import { InboxPanel } from '../features/inbox/InboxPanel';
import { useInbox } from '../features/inbox/useInbox';
import { RuntimePanel } from '../features/runtime/RuntimePanel';

export function App() {
  const {
    config,
    agents,
    selected,
    setSelected,
    loading,
    error,
    setError,
    busy,
    toggle,
    connected,
  } = useAgents();
  const inbox = useInbox(selected, setError);
  const [form, setForm] = useState<'new' | Agent | null>(null);
  const active = agents.find((agent) => agent.agent_id === selected);
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">✦</span>
          <div>
            <strong>StarryChat</strong>
            <small>本机 Adaptor</small>
          </div>
        </div>
        <span className="summary">
          {agents.filter((agent) => agent.connection_state === 'online').length} / {agents.length}{' '}
          个 Agent 已连接
        </span>
      </header>
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      <div className="layout">
        <AgentList
          agents={agents}
          selected={selected}
          loading={loading}
          config={config}
          onConnect={() => setForm('new')}
          onSelect={(id) => {
            setSelected(id);
            inbox.reset();
          }}
        />
        <main>
          {!active ? (
            <div className="empty">
              <span className="empty-icon">✦</span>
              <h1>让 Agent 与消息连接</h1>
              <p>
                接入账号后，后台会持续连接 Trigger，
                <br />
                将收到的消息保存在这台电脑上。
              </p>
              <button className="primary" onClick={() => setForm('new')}>
                接入 Agent 账号
              </button>
            </div>
          ) : (
            <>
              <AgentHeader
                agent={active}
                busy={busy}
                onReauthenticate={() => setForm(active)}
                onToggle={() => void toggle(active)}
              />
              <RuntimePanel key={active.agent_id} agent={active} messages={inbox.messages} />
              <InboxPanel
                messages={inbox.messages}
                before={inbox.before}
                hasMore={inbox.hasMore}
                onLatest={inbox.reset}
                onOlder={inbox.older}
              />
            </>
          )}
        </main>
      </div>
      {form && (
        <AgentConnectDialog
          key={form === 'new' ? 'new' : form.agent_id}
          target={form}
          onClose={() => setForm(null)}
          onConnected={(agent) => {
            connected(agent);
            inbox.reset();
            setForm(null);
          }}
        />
      )}
    </div>
  );
}
