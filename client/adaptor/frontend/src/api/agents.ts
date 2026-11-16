import { api } from './client';
import type { Agent, AgentCredentials, Config } from './types';

export function getConfig(signal?: AbortSignal) {
  return api<Config>('/config', { signal });
}
export function listAgents(signal?: AbortSignal) {
  return api<{ agents: Agent[] }>('/agents', { signal });
}
export function connectAgent(credentials: AgentCredentials) {
  return api<{ agent: Agent }>('/agents', { method: 'POST', body: JSON.stringify(credentials) });
}
export function reauthenticateAgent(agentId: string, credentials: AgentCredentials) {
  return api<{ agent: Agent }>(`/agents/${agentId}/reauthenticate`, {
    method: 'POST',
    body: JSON.stringify(credentials),
  });
}
export function setAgentEnabled(agentId: string, enabled: boolean) {
  return api<{ agent: Agent }>(`/agents/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
}
