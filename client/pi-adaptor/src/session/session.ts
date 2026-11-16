import { mkdirSync, statSync } from 'node:fs';
import type { RpcClient } from '@earendil-works/pi-coding-agent';
import { displayEvent } from './events.ts';
import { ConfigurationError, InputError, errorMessage } from '../model/errors.ts';
import type { Input, NativeRef, OpenConfig, Receipt, Session, SessionEvent, SessionState } from '../model/types.ts';
import { readModelSelection } from '../config/selection.ts';
import { readPrivateConfig } from '../config/files.ts';
import { readSystemPrompt } from '../config/prompt.ts';
import { configureMcp } from '../config/mcp.ts';
import { isolatedEnvironment } from './environment.ts';
import { locateSessionFile, validateSessionFile, readPersistedInputs } from './history.ts';

export class PiSession implements Session {
  private config: OpenConfig;
  private rpc?: RpcClient;
  private listeners = new Set<(event: SessionEvent) => void>();
  private timer?: NodeJS.Timeout;
  private checking?: Promise<SessionState>;
  private closing?: Promise<void>;
  private closed = false;
  private unsettled = false;
  private ref: NativeRef;

  constructor(config: OpenConfig) { this.config = config; this.ref = { ...config.nativeRef }; }

  onEvent(listener: (event: SessionEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: SessionEvent) { if (!this.closed) for (const listener of this.listeners) listener(event); }

  private locate() {
    const { sessionDir, allowCreate } = this.config;
    this.ref.session_file = locateSessionFile(this.ref, sessionDir, allowCreate);
  }

  async open(): Promise<SessionState> {
    if (this.rpc || this.closed) throw new Error('会话实例不能重复打开');
    const selection = readModelSelection(this.config.settings.pi_config_dir);
    if (!selection.provider || !selection.model) throw new ConfigurationError('请在运行配置中选择 Provider 和 Model（保存到 pi-config/settings.json）');
    readPrivateConfig(this.config.settings.pi_config_dir, 'auth.json');
    readPrivateConfig(this.config.settings.pi_config_dir, 'models.json');
    readSystemPrompt(this.config.settings.pi_config_dir);
    if (!statSync(this.config.cliPath).isFile()) throw new Error('Pi RPC 入口不存在，请先构建 Pi');
    if (!statSync(this.config.cwd).isDirectory()) throw new Error('Pi 工作目录不存在');
    this.locate();
    mkdirSync(this.config.settings.pi_config_dir, { recursive: true, mode: 0o700 });
    configureMcp(this.config.settings.pi_config_dir, this.config.cwd, this.config.mcpServers ?? []);
    // Loading Pi is deferred: a missing/broken Pi build must not stop the inbox service.
    const { RpcClient } = await import('@earendil-works/pi-coding-agent');
    if (this.closed) throw new Error('Pi 会话已关闭');
    const settings = this.config.settings;
    const args = ['--session-dir', this.config.sessionDir,
      ...(this.ref.session_file ? ['--session', this.ref.session_file] : ['--session-id', this.ref.session_id]),
      ...(settings.extensions ?? []).flatMap(path => ['--extension', path])];
    this.rpc = new RpcClient({ cliPath: this.config.cliPath, cwd: this.config.cwd,
      inheritEnv: false, env: isolatedEnvironment(settings.pi_config_dir), args });
    this.rpc.onEvent(event => {
      if (this.closed) return;
      if (event.type === 'agent_start') this.unsettled = true;
      if (event.type === 'agent_settled') this.unsettled = false;
      const mapped = displayEvent(event);
      if (mapped) this.emit(mapped);
      if (['agent_start', 'agent_settled', 'compaction_end', 'queue_update', 'entry_appended'].includes(event.type)) {
        void this.getState().catch(error => this.emit({ type: 'error', phase: 'probe', text: errorMessage(error) }));
      }
    });
    try {
      await this.rpc.start();
      const available = await this.rpc.getAvailableModels();
      if (!available.some(model => model.provider === selection.provider && model.id === selection.model)) {
        throw new ConfigurationError('所选模型不可用，请检查此 Agent 的 pi-config/models.json 和 auth.json，配置模型及认证');
      }
      const state = await this.getState();
      if (state.model?.provider !== selection.provider || state.model.id !== selection.model) {
        throw new ConfigurationError('Pi 未加载指定模型，请检查此 Agent 的 pi-config 配置');
      }
      this.timer = setInterval(() => {
        if (!this.checking) void this.getState().catch(error => this.emit({ type: 'error', phase: 'probe', text: errorMessage(error) }));
      }, 10000);
      this.timer.unref();
      return state;
    } catch (error) { await this.close(); throw error; }
  }

  getState(): Promise<SessionState> {
    if (this.closed || !this.rpc) return Promise.reject(new Error('Pi 会话未打开'));
    if (this.checking) return this.checking;
    this.checking = this.rpc.getState().then(state => {
      if (this.closed) throw new Error('Pi 会话已关闭');
      if (state.sessionId !== this.ref.session_id) throw new Error('Pi 会话身份发生变化，已停止派发');
      this.ref.session_file = validateSessionFile(this.ref, state.sessionFile);
      const view: SessionState = { nativeRef: { ...this.ref },
        status: state.isCompacting ? 'compacting' : state.isStreaming || this.unsettled || state.pendingMessageCount > 0 ? 'busy' : 'idle',
        pending: state.pendingMessageCount, model: state.model ? { provider: state.model.provider, id: state.model.id } : null };
      this.emit({ type: 'state', state: view });
      return view;
    }).finally(() => { this.checking = undefined; });
    return this.checking;
  }

  async sendInput(input: Input): Promise<Receipt> {
    if (this.closed || !this.rpc) throw new InputError('retryable', 'Pi 会话尚未就绪');
    try {
      const disposition = await this.rpc.prompt(input.text, undefined, 'steer');
      if (!['started', 'queued', 'handled'].includes(disposition)) throw new InputError('unknown', 'Pi 返回了未知输入回执');
      return { inputId: input.id, disposition };
    } catch (error) {
      if (error instanceof InputError) throw error;
      const message = errorMessage(error);
      // Only known preflight rejections are safe to retry. Extensions may have side effects before throwing.
      if (message.startsWith('Cannot submit a prompt while compaction')) throw new InputError('retryable', message);
      if (/^(No model|No API key|Authentication failed for)/.test(message)) throw new InputError('rejected', message);
      throw new InputError('unknown', message);
    }
  }

  async persistedInputs(): Promise<Set<string>> {
    this.locate();
    return readPersistedInputs(this.ref.session_file);
  }

  async abort() { if (this.closed || !this.rpc) throw new Error('Pi 会话未打开'); await this.rpc.abort(); }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.timer);
    this.closing = (async () => {
      if (!this.rpc) return;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([this.rpc.abort().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]);
      } finally { clearTimeout(timer); await this.rpc.stop(); }
    })();
    return this.closing;
  }
}
