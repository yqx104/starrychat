import type { Agent, Config } from '../../api/types';
import { connectionLabels } from './labels';

export function AgentList({
  agents,
  selected,
  loading,
  config,
  onConnect,
  onSelect,
}: {
  agents: Agent[];
  selected: string | undefined;
  loading: boolean;
  config: Config | undefined;
  onConnect: () => void;
  onSelect: (agentId: string) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="section-heading">
        <h2>本机 Agent</h2>
        <button className="primary small" onClick={onConnect}>
          ＋ 接入账号
        </button>
      </div>
      <div className="agent-list">
        {loading ? (
          <p className="hint">正在读取…</p>
        ) : agents.length === 0 ? (
          <p className="hint">添加一个已有的 IM Agent 账号，开始接收消息。</p>
        ) : (
          agents.map((agent) => (
            <button
              key={agent.agent_id}
              className={`agent-row ${selected === agent.agent_id ? 'selected' : ''}`}
              onClick={() => onSelect(agent.agent_id)}
            >
              <span className="avatar">{agent.name.slice(0, 1)}</span>
              <span className="agent-label">
                <strong>{agent.name}</strong>
                <small>@{agent.username}</small>
              </span>
              <span
                className={`dot ${agent.connection_state}`}
                title={connectionLabels[agent.connection_state]}
              />
            </button>
          ))
        )}
      </div>
      <div className="server-card">
        <span className="eyebrow">连接到服务端</span>
        <label>IM</label>
        <code>{config?.im_base_url ?? '—'}</code>
        <label>Trigger</label>
        <code>{config?.trigger_ws_url ?? '—'}</code>
      </div>
    </aside>
  );
}
