import { useEffect, useState } from 'react';
import { getConfig, listAgents, setAgentEnabled } from '../../api/agents';
import type { Agent, Config } from '../../api/types';

export function useAgents() {
  const [config, setConfig] = useState<Config>();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getConfig(controller.signal)
      .then(setConfig)
      .catch(() => {});
    const poll = async () => {
      try {
        const data = await listAgents(controller.signal);
        if (controller.signal.aborted) return;
        setAgents(data.agents);
        setSelected((current) => current ?? data.agents[0]?.agent_id);
        setError('');
      } catch {
        if (!controller.signal.aborted)
          setError('无法连接本机 adaptor 服务，请检查服务是否已启动。');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  async function toggle(active: Agent) {
    setBusy(true);
    try {
      const { agent } = await setAgentEnabled(active.agent_id, !active.enabled);
      setAgents((current) =>
        current.map((item) => (item.agent_id === agent.agent_id ? agent : item)),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  function connected(agent: Agent) {
    setAgents((current) => [...current.filter((item) => item.agent_id !== agent.agent_id), agent]);
    setSelected(agent.agent_id);
  }
  return {
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
  };
}
