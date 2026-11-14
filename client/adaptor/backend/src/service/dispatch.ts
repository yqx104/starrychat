import { InputError, errorMessage } from '@starrychat/pi-adaptor';
import { Store } from '../repository/store.ts';
import { Sessions } from './sessions.ts';
import { formatInput } from './input.ts';

export class Dispatcher {
  private store: Store;
  private sessions: Sessions;
  private jobs = new Map<string, { again: boolean; promise: Promise<void> }>();
  private retries = new Map<string, { at: number; count: number }>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  constructor(store: Store, sessions: Sessions) { this.store = store; this.sessions = sessions; }
  start() {
    const scan = () => { for (const agent of this.store.agents()) if (agent.enabled) this.wake(agent.agent_id); };
    scan(); this.timer = setInterval(scan, 2000); this.timer.unref();
  }
  wake(agentId: string) {
    if (this.stopped) return;
    const record = this.store.session(agentId);
    if (!record || !this.sessions.current(agentId)) return;
    const key = record.session_id;
    const existing = this.jobs.get(key);
    if (existing) { existing.again = true; return; }
    const job = { again: false, promise: Promise.resolve() };
    this.jobs.set(key, job);
    job.promise = this.pump(agentId, key).catch(error => {
      const runtime = this.sessions.current(agentId);
      if (runtime) this.sessions.fail(agentId, runtime, errorMessage(error));
    }).finally(() => {
      this.jobs.delete(key);
      if (job.again && !this.stopped) queueMicrotask(() => this.wake(agentId));
    });
  }
  private async pump(agentId: string, key: string) {
    while (!this.stopped) {
      const runtime = this.sessions.current(agentId);
      if (!runtime || (this.retries.get(key)?.at ?? 0) > Date.now()) return;
      const row = this.store.nextInput(agentId);
      if (!row || row.state !== 'pending' || !this.store.claim(row.id)) return;
      try {
        const receipt = await runtime.session.sendInput({ id: row.id, text: formatInput(row) });
        if (!this.sessions.isCurrent(agentId, runtime)) return;
        if (receipt.inputId !== row.id) throw new InputError('unknown', '输入回执身份不匹配');
        this.store.finish(row.id, 'accepted', receipt.disposition);
        this.retries.delete(key);
      } catch (error) {
        if (!this.sessions.isCurrent(agentId, runtime)) return;
        const kind = error instanceof InputError ? error.kind : 'unknown';
        const message = errorMessage(error);
        this.store.finish(row.id, kind === 'retryable' ? 'pending' : kind === 'rejected' ? 'rejected' : 'needs_recovery', null, message);
        if (kind === 'retryable') {
          const count = (this.retries.get(key)?.count ?? 0) + 1;
          this.retries.set(key, { count, at: Date.now() + Math.min(30000, 1000 * 2 ** Math.min(count - 1, 5)) });
        }
        if (kind === 'unknown') this.sessions.fail(agentId, runtime, message);
        return;
      }
    }
  }
  stop() { this.stopped = true; clearInterval(this.timer); }
  async drain() { await Promise.allSettled([...this.jobs.values()].map(job => job.promise)); }
}
