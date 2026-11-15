import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { APIError } from '../model/errors.ts';
import { ConfigurationError, errorMessage, readModelSelection, readModelOptions, saveModelConfiguration, readSystemPrompt, validateSystemPrompt, type SystemPromptConfiguration, type ModelConfiguration, type ModelSelection, type ProviderOption, type PiSettings, type NativeRef, type Session, type SessionEvent, type SessionFactory, type SessionState } from '@starrychat/pi-adaptor';
import type { Config } from '../config/config.ts';
import { Store } from '../repository/store.ts';
import type { SessionRecord } from '../model/types.ts';
import { createSession } from '../clients/harnesses.ts';
import { formatInput } from './input.ts';
import { agentDirectories, prepareAgentDirectories } from './directories.ts';

export interface Runtime {
  session: Session; record: SessionRecord; ready: boolean; status: string;
  error: string | null; state?: SessionState;
}
export interface DisplayEvent extends SessionEvent { id: number; at: number }

function runtimeSettings(value: unknown, defaultDirectory: string): PiSettings & ModelConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new APIError(400, 'INVALID_REQUEST', 'config 必须为对象');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['provider', 'model', 'base_url', 'api', 'api_key', 'clear_api_key', 'system_prompt', 'extensions'].includes(key))) {
    throw new APIError(400, 'INVALID_REQUEST', '只接受模型、接口、API Key、系统提示词和扩展配置；目录由 adaptor 管理');
  }
  const settings: PiSettings & ModelConfiguration = { pi_config_dir: defaultDirectory };
  if (input.provider !== undefined || input.model !== undefined) {
    if (typeof input.provider !== 'string' || typeof input.model !== 'string' || !!input.provider.trim() !== !!input.model.trim()) {
      throw new APIError(400, 'INVALID_REQUEST', 'provider 和 model 需要同时填写');
    }
    settings.provider = input.provider.trim(); settings.model = input.model.trim();
  }
  for (const key of ['base_url', 'api', 'api_key'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string') throw new APIError(400, 'INVALID_REQUEST', '接口和密钥配置必须为字符串');
      settings[key] = input[key].trim();
    }
  }
  if (input.clear_api_key !== undefined) {
    if (typeof input.clear_api_key !== 'boolean') throw new APIError(400, 'INVALID_REQUEST', 'clear_api_key 必须为布尔值');
    settings.clear_api_key = input.clear_api_key;
  }
  if (!settings.provider && (settings.base_url || settings.api || settings.api_key || settings.clear_api_key)) {
    throw new APIError(400, 'INVALID_REQUEST', '请先填写 Provider 和 Model');
  }
  if (input.system_prompt !== undefined) {
    try { settings.system_prompt = validateSystemPrompt(input.system_prompt); }
    catch (error) { throw new APIError(400, 'INVALID_CONFIG', error instanceof ConfigurationError ? error.message : '系统提示词配置无效'); }
  }
  if (input.extensions !== undefined) {
    if (!Array.isArray(input.extensions) || input.extensions.length > 20 || input.extensions.some(path => typeof path !== 'string' || !isAbsolute(path))) {
      throw new APIError(400, 'INVALID_REQUEST', '扩展必须是绝对路径数组，最多 20 项');
    }
    settings.extensions = input.extensions;
  }
  return settings;
}

export class Sessions {
  private store: Store;
  private config: Config;
  private factory: SessionFactory;
  private runtimes = new Map<string, Runtime>();
  private operations = new Map<string, Promise<void>>();
  private events = new Map<string, DisplayEvent[]>();
  private droppedThrough = new Map<string, number>();
  private sequence = 0;
  private closed = false;
  onReady: (agentId: string) => void = () => {};
  readonly eventEpoch = randomUUID();

  constructor(store: Store, config: Config, factory: SessionFactory = createSession) {
    this.store = store; this.config = config; this.factory = factory;
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

  private pathsMatch(record: SessionRecord) {
    const directories = agentDirectories(this.config, record.agent_id);
    const settings = JSON.parse(record.config_json) as PiSettings;
    const ref = record.native_ref_json ? JSON.parse(record.native_ref_json) as NativeRef : null;
    return record.cwd === directories.cwd && settings.pi_config_dir === directories.pi_config_dir &&
      (!ref?.session_file || dirname(ref.session_file) === join(directories.sessions_dir, record.session_id));
  }

  runtimeConfig(agentId: string) {
    this.requireAgent(agentId);
    const record = this.store.session(agentId);
    const directories = agentDirectories(this.config, agentId);
    const settings: Partial<PiSettings> = record ? JSON.parse(record.config_json) : {};
    let selection: ModelSelection = {}; let modelOptions: ProviderOption[] = []; let configurationIssue: string | null = null;
    try { selection = readModelSelection(directories.pi_config_dir); modelOptions = readModelOptions(directories.pi_config_dir); }
    catch (error) { configurationIssue = errorMessage(error); }
    let systemPrompt: SystemPromptConfiguration = { mode: 'default', text: '' };
    try { systemPrompt = readSystemPrompt(directories.pi_config_dir); }
    catch (error) { configurationIssue ??= errorMessage(error); }
    return { runtime: { harness: 'pi' as const, config: { extensions: settings.extensions ?? [], ...selection, system_prompt: systemPrompt } },
      model_options: modelOptions, configuration_issue: configurationIssue, directories };
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
    const { directories } = this.runtimeConfig(agentId);
    if (input.harness !== 'pi' || Object.keys(input).some(key => !['harness', 'config'].includes(key))) {
      throw new APIError(400, 'INVALID_REQUEST', '只接受 harness=pi 和 config；目录由 adaptor 管理');
    }
    const settings = runtimeSettings(input.config ?? {}, directories.pi_config_dir);
    const existing = this.store.session(agentId);
    if (existing) {
      if (!this.pathsMatch(existing)) throw new APIError(409, 'AGENT_DIRECTORY_MISMATCH', 'Pi 目录与 agent_root 不一致，请停服并迁移现有目录和数据库路径');
      const editable = () => !this.requireAgent(agentId).enabled || this.runtimes.get(agentId)?.status === 'unconfigured';
      if (!editable()) throw new APIError(409, 'AGENT_ENABLED', '修改运行中的配置前请先停用 Agent');
      if (!this.requireAgent(agentId).enabled) await this.reconcileNow(agentId);
      if (!editable()) throw new APIError(409, 'AGENT_ENABLED', 'Agent 已重新启用，请先停用');
    }
    prepareAgentDirectories(this.config, agentId);
    const { pi_config_dir, extensions, ...modelConfig } = settings;
    try { saveModelConfiguration(directories.pi_config_dir, modelConfig); }
    catch (error) { throw new APIError(400, 'INVALID_CONFIG', error instanceof ConfigurationError ? error.message : '无法保存 pi-config 配置，请检查目录权限'); }
    this.store.configure(agentId, directories.cwd, { pi_config_dir,
      extensions: extensions ?? (existing ? JSON.parse(existing.config_json).extensions : []) });
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
    return !this.closed && this.store.agent(agentId)?.enabled && runtime?.ready ? runtime : undefined;
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
        native_ref: record.native_ref_json ? JSON.parse(record.native_ref_json) as NativeRef : null } };
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
    if (!this.pathsMatch(runtime.record)) return;
    const rows = this.store.recoverable(runtime.record.agent_id);
    if (!rows.length) return;
    let persisted = new Set<string>();
    try { persisted = await runtime.session.persistedInputs(); } catch { /* Unreadable history requires manual recovery. */ }
    for (const row of rows) this.store.recovery(row.id, persisted.has(formatInput(row)), reason);
  }
  private async stop(runtime: Runtime) {
    const unconfigured = runtime.status === 'unconfigured';
    runtime.ready = false; runtime.status = 'stopping';
    try { await runtime.session.close(); }
    finally {
      if (!unconfigured) await this.recover(runtime, 'Pi 实例已关闭，未能确认输入已写入历史；请核对后处理');
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
      const ref: NativeRef = record.native_ref_json ? JSON.parse(record.native_ref_json) : { session_id: randomUUID(), session_file: null };
      this.store.nativeRef(record.session_id, ref);
      const directories = agentDirectories(this.config, agentId);
      const settings = JSON.parse(record.config_json) as PiSettings;
      const sessionDir = join(directories.sessions_dir, record.session_id);
      const session = this.factory({ cwd: record.cwd, settings, nativeRef: ref,
        cliPath: this.config.pi_cli_path!, sessionDir,
        allowCreate: !this.store.hasHistory(agentId) });
      const runtime: Runtime = { session, record, ready: false, status: 'starting', error: null };
      this.runtimes.set(agentId, runtime);
      session.onEvent(event => {
        if (this.closed || this.runtimes.get(agentId) !== runtime || ['stopping', 'disabled', 'error'].includes(runtime.status)) return;
        if (event.type === 'state' && event.state) {
          this.store.nativeRef(record.session_id, event.state.nativeRef);
          runtime.state = event.state;
          if (runtime.ready) runtime.status = event.state.status;
          if (runtime.ready) this.onReady(agentId);
        } else {
          this.recordEvent(record, event);
          if (event.type === 'error' && event.phase === 'probe') this.fail(agentId, runtime, event.text ?? 'Pi 状态检查失败');
        }
      });
      try {
        if (!this.pathsMatch(record)) {
          throw new Error('Pi 目录与 agent_root 不一致，请停服并迁移现有目录和数据库路径');
        }
        const state = await session.open();
        this.store.nativeRef(record.session_id, state.nativeRef);
        await this.recover(runtime, '上次输入结果不确定，未在 Pi 历史中找到完整输入；请核对后处理');
        if (this.closed || !this.store.agent(agentId)?.enabled) { await this.stop(runtime); return; }
        if (runtime.status === 'error') return;
        runtime.state = state; runtime.ready = true; runtime.status = state.status;
        this.onReady(agentId);
      } catch (error) {
        await session.close().catch(() => {});
        const unconfigured = error instanceof ConfigurationError;
        if (!unconfigured) await this.recover(runtime, 'Pi 会话启动失败，原输入保留待恢复');
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
    await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.session.close()));
    await Promise.allSettled(this.operations.values());
    await Promise.allSettled([...this.runtimes.values()].map(runtime => this.stop(runtime)));
  }
}
