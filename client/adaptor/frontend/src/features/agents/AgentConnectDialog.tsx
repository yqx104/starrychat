import { useState, type FormEvent } from 'react';
import { connectAgent, reauthenticateAgent } from '../../api/agents';
import type { Agent } from '../../api/types';
import { Modal } from '../../components/Modal';

export function AgentConnectDialog({
  target,
  onConnected,
  onClose,
}: {
  target: 'new' | Agent;
  onConnected: (agent: Agent) => void;
  onClose: () => void;
}) {
  const [username, setUsername] = useState(target === 'new' ? '' : target.username);
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      const credentials = { username, password };
      const { agent } = await (target === 'new'
        ? connectAgent(credentials)
        : reauthenticateAgent(target.agent_id, credentials));
      setPassword('');
      onConnected(agent);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '接入失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal titleId="form-title" title={target === 'new' ? '接入 Agent 账号' : '重新认证'}>
      <p>使用已在 IM 创建的 Agent 账号。</p>
      <form onSubmit={submit}>
        <label htmlFor="username">用户名</label>
        <input
          id="username"
          autoFocus
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
        <label htmlFor="password">密码</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        {formError && (
          <div role="alert" className="form-error">
            {formError}
          </div>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setPassword('');
              onClose();
            }}
          >
            取消
          </button>
          <button className="primary" disabled={saving}>
            {saving ? '正在验证…' : '验证并接入'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
