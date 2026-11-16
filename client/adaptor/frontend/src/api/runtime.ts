import { api } from './client';
import type {
  EventPage,
  MainSession,
  RecoveryAction,
  RuntimeDetails,
  UpdateRuntimeInput,
} from './types';

export function getMainSession(agentId: string, signal?: AbortSignal) {
  return api<MainSession>(`/agents/${agentId}/main-session`, { signal });
}
export function getSessionEvents(
  sessionId: string,
  cursor: number,
  epoch: string,
  signal?: AbortSignal,
) {
  return api<EventPage>(`/sessions/${sessionId}/events?after=${cursor}&epoch=${epoch}`, { signal });
}
export function abortSession(sessionId: string) {
  return api<MainSession>(`/sessions/${sessionId}/abort`, { method: 'POST', body: '{}' });
}
export function resolveInput(sessionId: string, inputId: number, action: RecoveryAction) {
  return api<unknown>(`/sessions/${sessionId}/inputs/${inputId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ action, confirmed: true }),
  });
}
export function getRuntime(agentId: string, signal?: AbortSignal) {
  return api<RuntimeDetails>(`/agents/${agentId}/runtime`, { signal });
}
export function updateRuntime(agentId: string, input: UpdateRuntimeInput) {
  return api<MainSession>(`/agents/${agentId}/runtime`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}
