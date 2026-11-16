import type { Agent } from '../../api/types';
import { connectionLabels } from './labels';

export function AgentHeader({
  agent,
  busy,
  onReauthenticate,
  onToggle,
}: {
  agent: Agent;
  busy: boolean;
  onReauthenticate: () => void;
  onToggle: () => void;
}) {
  return (
    <>
      <div className="agent-header">
        <div>
          <div className="title-line">
            <h1>{agent.name}</h1>
            <span className={`badge ${agent.connection_state}`}>
              Trigger · {connectionLabels[agent.connection_state] ?? agent.connection_state}
            </span>
          </div>
          <p className="identity">{agent.agent_id}</p>
        </div>
        <div className="actions">
          <button onClick={onReauthenticate}>重新认证</button>
          <button disabled={busy} onClick={onToggle}>
            {agent.enabled ? '停用 Agent' : '启用 Agent'}
          </button>
        </div>
      </div>
      {agent.last_error && <div className="notice">{agent.last_error}</div>}
    </>
  );
}
