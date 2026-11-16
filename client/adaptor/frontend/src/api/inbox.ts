import { api } from './client';
import type { InboxPage } from './types';

export function getInbox(agentId: string, before: number | undefined, signal?: AbortSignal) {
  return api<InboxPage>(
    `/agents/${agentId}/inbox?limit=50${before ? `&before_id=${before}` : ''}`,
    { signal },
  );
}
