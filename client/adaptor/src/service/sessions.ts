import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { APIError } from '../model/errors.ts';
import { ConfigurationError, errorMessage, type Harness, type OpenConfig, type Session, type SessionEvent, type SessionState, type McpConnection } from '@starrychat/adaptor-contracts';
import type { Config } from '../config/config.ts';
import { Store } from '../repository/store.ts';
import type { SessionRecord } from '../model/types.ts';
import { createHarnesses } from '../clients/harnesses.ts';
import { formatInput } from './input.ts';
import { agentDirectories, prepareAgentDirectories } from './directories.ts';

export interface Runtime {
  session: Session | null; record: SessionRecord; ready: boolean; status: string;
  error: string | null; state?: SessionState;
}
export interface DisplayEvent extends SessionEvent { id: number; at: number }

export class Sessions {
  private store: Store;
  private config: Config;
  private harnesses: readonly Harness[];
  private mcpServers: (agentId: string) => McpConnection[];
  private runtimes = new Map<string, Runtime>();
  private operations = new Map<string, Promise<void>>();
  private events = new Map<string, DisplayEvent[]>();
  private droppedThrough = new Map<string, number>();
  private sequence = 0;
  private closed = false;
  onReady: (agentId: string) => void = () => {};
  readonly eventEpoch = randomUUID();

  constructor(store: Store, config: Config, harnesses: readonly Harness[] = createHarnesses(config),
    mcpServers: (agentId: string) => McpConnection[] = () => []) {
    this.store = store; this.config = config; this.harnesses = harnesses; this.mcpServers = mcpServers;
  }

  private requireAgent(agentId: string) {
    const agent = this.store.agent(agentId);
    if (!agent) throw new APIError(404, 'NOT_FOUND', 'Agent 不存在');
    return agent;
  }

  require(sessionId: string) {
    const record = this.store.sessionById(sessionId);
    if (!record) throw new APIError(404, 'NOT_FOUND', '会话不存在');
    return record;
  }

  private harness(id = this.harnesses[0]?.id) {
    const harness = this.harnesses.find(item => item.id === id);
    if (!harness) throw new APIError(400, 'UNSUPPORTED_HARNESS', '未注册此运行器');
    return harness;
  }

  private sessionConfig(record: SessionRecord): OpenConfig {
    const directories = agentDirectories(this.config, record.agent_id);
    if (record.cwd !== directories.cwd) throw new Error('工作目录与 agent_root 不一致，请停服并迁移现有目录和数据库路径');
    return { root: directories.root, cwd: record.cwd, sessionDir: join(directories.sessions_dir, record.session_id),
      settings: JSON.parse(record.config_json), nativeRef: record.native_ref_json ? JSON.parse(record.native_ref_json) : null,
      allowCreate: !this.store.hasHistory(record.agent_id) };
  }

  private validateSession(record: SessionRecord) {
    this.harness(record.harness).validateSession(this.sessionConfig(record));
  }

  runtimeConfig(agentId: string) {
    this.requireAgent(agentId);
    const record = this.store.session(agentId);
    const directories = agentDirectories(this.config, agentId);
    const harness = this.harness(record?.harness);
    const { config, ...details } = harness.readConfig(directories, record ? JSON.parse(record.config_json) : null);
    return { ...details, runtime: { harness: harness.id, config } };
  }

  private serialize<T>(agentId: string, action: () => Promise<T>): Promise<T> {
    const result = (this.operations.get(agentId) ?? Promise.resolve()).then(action);
    const tail = result.then(() => {}, () => {}).finally(() => {
      if (this.operations.get(agentId) === tail) this.operations.delete(agentId);
    });
    this.operations.set(agentId, tail);
    return result;
  }

  configure(agentId: string, input: Record<string, unknown>) {
    return this.serialize(agentId, () => this.configureNow(agentId, input));
  }

  private async configureNow(agentId: string, input: Record<string, unknown>) {
    if (this.closed) throw new APIError(409, 'SERVICE_STOPPING', '服务正在停止，请稍后重试');
    this.requireAgent(agentId);
    if (typeof input.harness !== 'string' || Object.keys(input).some(key => !['harness', 'config'].includes(key))) {
      throw new APIError(400, 'INVALID_REQUEST', '只接受 harness 和 config；目录由 adaptor 管理');
    }
    const harness = this.harness(input.harness);
    try { harness.validateConfig(input.config ?? {}); }
    catch (error) { throw new APIError(400, 'INVALID_CONFIG', errorMessage(error)); }
    const existing = this.store.session(agentId);
    if (existing) {
      if (existing.harness !== harness.id) throw new APIError(409, 'HARNESS_MISMATCH', '已有会话不能直接切换运行器');
      try { this.validateSession(existing); }
      catch (error) { throw new APIError(409, 'AGENT_DIRECTORY_MISMATCH', errorMessage(error)); }
      const editable = () => !this.requireAgent(agentId).enabled || this.runtimes.get(agentId)?.status === 'unconfigured';
      if (!editable()) throw new APIError(409, 'AGENT_ENABLED', '修改运行中的配置前请先停用 Agent');
      if (!this.requireAgent(agentId).enabled) await this.reconcileNow(agentId);
      if (!editable()) throw new APIError(409, 'AGENT_ENABLED', 'Agent 已重新启用，请先停用');
    }
    const directories = prepareAgentDirectories(this.config, agentId);
    let settings: unknown;
    try { settings = harness.saveConfig(directories, input.config ?? {}, existing ? JSON.parse(existing.config_json) : null); }
    catch (error) { throw new APIError(400, 'INVALID_CONFIG', errorMessage(error)); }
    this.store.configure(agentId, harness.id, directories.cwd, settings);
    await this.reconcileNow(agentId);
    return this.view(agentId);
  }

  async resolveInput(sessionId: string, inputId: number, action: 'retry' | 'accepted') {
    const record = this.require(sessionId);
    if (this.requireAgent(record.agent_id).enabled) throw new APIError(409, 'AGENT_ENABLED', '请先停用 Agent，再处理恢复记录');
    await this.reconcile(record.agent_id);
    if (this.requireAgent(record.agent_id).enabled) throw new APIError(409, 'AGENT_ENABLED', 'Agent 已重新启用，请先停用');
    if (!this.store.resolveInput(record.agent_id, inputId, action)) {
      throw new APIError(409, 'INPUT_STATE_CHANGED', '输入已不处于拒绝或待恢复状态，请刷新');
    }
  }

  startAll() { for (const agent of this.store.agents()) void this.reconcile(agent.agent_id); }
  current(agentId: string) {
    const runtime = this.runtimes.get(agentId);
    return !this.closed && this.store.agent(agentId)?.enabled && runtime?.ready && runtime.session
      ? runtime as Runtime & { session: Session } : undefined;
  }
  isCurrent(agentId: string, runtime: Runtime) { return this.current(agentId) === runtime; }
  view(agentId: string) {
    this.requireAgent(agentId);
    const record = this.store.session(agentId);
    if (!record) return { status: this.store.agent(agentId)?.enabled ? 'unconfigured' : 'disabled', session: null, last_error: null };
    const runtime = this.runtimes.get(agentId);
    const head = this.store.nextInput(agentId);
    return { status: runtime?.status ?? (this.store.agent(agentId)?.enabled ? 'stopped' : 'disabled'),
      last_error: runtime?.error ?? null, blocked: head && ['rejected', 'needs_recovery'].includes(head.state) ? head.state : null,
      pending: runtime?.state?.pending ?? 0, model: runtime?.state?.model ?? null,
      session: { session_id: record.session_id, harness: record.harness, cwd: record.cwd,
        native_ref: record.native_ref_json ? JSON.parse(record.native_ref_json) as unknown : null } };
  }
  readEvents(sessionId: string, after: number) {
    const events = this.events.get(sessionId) ?? [];
    return { epoch: this.eventEpoch, events: events.filter(event => event.id > after),
      truncated: (this.droppedThrough.get(sessionId) ?? 0) > after };
  }
  private recordEvent(record: SessionRecord, event: SessionEvent) {
    const events = this.events.get(record.session_id) ?? [];
    events.push({ ...event, id: ++this.sequence, at: Date.now() });
    if (events.length > 300) {
      const removed = events.splice(0, events.length - 300);
      this.droppedThrough.set(record.session_id, removed.at(-1)!.id);
    }
    this.events.set(record.session_id, events);
  }
  private async recover(runtime: Runtime, reason: string) {
    if (!runtime.session) return;
    try { this.validateSession(runtime.record); } catch { return; }
    const rows = this.store.recoverable(runtime.record.agent_id);
    if (!rows.length) return;
    let persisted = new Set<number>();
    try { persisted = await runtime.session.recoverInputs(rows.map(row => ({ id: row.id, text: formatInput(row) }))); }
    catch { /* Unreadable history requires manual recovery. */ }
    for (const row of rows) this.store.recovery(row.id, persisted.has(row.id), reason);
  }
  private async stop(runtime: Runtime) {
    const unconfigured = runtime.status === 'unconfigured';
    runtime.ready = false; runtime.status = 'stopping';
    try { await runtime.session?.close(); }
    finally {
      if (!unconfigured) await this.recover(runtime, '运行实例已关闭，未能确认输入已持久化；请核对后处理');
      runtime.status = 'disabled';
    }
  }
  reconcile(agentId: string): Promise<void> {
    return this.serialize(agentId, () => this.reconcileNow(agentId));
  }
  private async reconcileNow(agentId: string): Promise<void> {
    try {
      const existing = this.runtimes.get(agentId);
      const enabled = !this.closed && !!this.store.agent(agentId)?.enabled;
      if (existing?.ready && enabled) return;
      if (existing) { await this.stop(existing); this.runtimes.delete(agentId); }
      const record = this.store.session(agentId);
      if (this.closed || !this.store.agent(agentId)?.enabled || !record) return;
      const runtime: Runtime = { session: null, record, ready: false, status: 'starting', error: null };
      this.runtimes.set(agentId, runtime);
      try {
        const harness = this.harness(record.harness);
        const config = this.sessionConfig(record);
        harness.validateSession(config);
        const session = harness.createSession({ ...config, mcpServers: this.mcpServers(agentId) });
        runtime.session = session;
        const saveReference = (ref: unknown) => {
          this.store.nativeRef(record.session_id, ref);
          record.native_ref_json = JSON.stringify(ref);
        };
        saveReference(session.nativeRef);
        session.onEvent(event => {
          if (this.closed || this.runtimes.get(agentId) !== runtime || ['stopping', 'disabled', 'error'].includes(runtime.status)) return;
          if (event.type === 'state' && event.state) {
            saveReference(event.state.nativeRef);
            runtime.state = event.state;
            if (runtime.ready) runtime.status = event.state.status;
            if (runtime.ready) this.onReady(agentId);
          } else {
            this.recordEvent(record, event);
            if (event.type === 'error' && event.fatal) this.fail(agentId, runtime, event.text ?? '运行实例不可用');
          }
        });
        const state = await session.open();
        saveReference(state.nativeRef);
        await this.recover(runtime, '上次输入结果不确定，运行器未能确认输入已持久化；请核对后处理');
        if (this.closed || !this.store.agent(agentId)?.enabled) { await this.stop(runtime); return; }
        if (runtime.status === 'error') return;
        runtime.state = state; runtime.ready = true; runtime.status = state.status;
        this.onReady(agentId);
      } catch (error) {
        await runtime.session?.close().catch(() => {});
        const unconfigured = error instanceof ConfigurationError;
        if (!unconfigured) await this.recover(runtime, '会话启动失败，原输入保留待恢复');
        runtime.ready = false; runtime.state = undefined;
        runtime.status = unconfigured ? 'unconfigured' : 'error'; runtime.error = errorMessage(error);
        if (!unconfigured) this.recordEvent(record, { type: 'error', text: runtime.error });
      }
    } catch (error) {
      const runtime = this.runtimes.get(agentId);
      if (runtime) { runtime.ready = false; runtime.status = 'error'; runtime.error = errorMessage(error); }
    }
  }
  fail(agentId: string, runtime: Runtime, reason: string) {
    if (this.runtimes.get(agentId) !== runtime || runtime.status === 'error') return;
    runtime.ready = false; runtime.status = 'error'; runtime.error = reason;
    // Close the uncertain instance before allowing an explicit re-enable/recovery.
    const previous = this.operations.get(agentId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      await this.stop(runtime);
      runtime.status = 'error'; runtime.error = reason;
    }).catch(() => { runtime.status = 'error'; }).finally(() => {
      if (this.operations.get(agentId) === operation) this.operations.delete(agentId);
    });
    this.operations.set(agentId, operation);
  }
  async abort(sessionId: string) {
    const record = this.require(sessionId);
    const runtime = this.current(record.agent_id);
    try {
      if (!runtime) throw new Error('会话未运行');
      await runtime.session.abort();
    } catch { throw new APIError(409, 'SESSION_UNAVAILABLE', '会话未运行或中止失败，请检查会话状态'); }
    return this.view(record.agent_id);
  }
  async close() {
    this.closed = true;
    for (const runtime of this.runtimes.values()) runtime.ready = false;
    // Cancel startup RPC waits too; do not wait 30 seconds for a broken process before closing it.
    await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.session?.close()));
    await Promise.allSettled(this.operations.values());
    await Promise.allSettled([...this.runtimes.values()].map(runtime => this.stop(runtime)));
  }
}
