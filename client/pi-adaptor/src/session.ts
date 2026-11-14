import { existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RpcClient } from '@earendil-works/pi-coding-agent';
import { displayEvent } from './events.ts';
import { InputError, errorMessage, type Input, type NativeRef, type OpenConfig, type Receipt, type Session, type SessionEvent, type SessionState } from './types.ts';

function header(path: string): { type: string; id: string } {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(16384);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    return JSON.parse(buffer.subarray(0, size).toString().split('\n')[0]);
  } finally { closeSync(fd); }
}

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
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    if (this.ref.session_file) {
      if (!existsSync(this.ref.session_file)) throw new Error('原 Pi 会话文件缺失；请恢复文件，不能创建空上下文');
      const value = header(this.ref.session_file);
      if (value.type !== 'session' || value.id !== this.ref.session_id) throw new Error('Pi 会话文件身份不匹配');
      return;
    }
    const matches = readdirSync(sessionDir).filter(name => name.endsWith('.jsonl')).filter(name => {
      const value = header(join(sessionDir, name));
      return value.type === 'session' && value.id === this.ref.session_id;
    });
    if (matches.length > 1) throw new Error('找到多个同 ID 的 Pi 会话文件，请先核对');
    if (matches.length === 1) this.ref.session_file = join(sessionDir, matches[0]);
    else if (!allowCreate) throw new Error('已有输入可能被处理，但无法确认 Pi 历史；请先核对待恢复输入');
  }

  async open(): Promise<SessionState> {
    if (this.rpc || this.closed) throw new Error('会话实例不能重复打开');
    if (!statSync(this.config.cliPath).isFile()) throw new Error('Pi RPC 入口不存在，请先构建 Pi');
    if (!statSync(this.config.cwd).isDirectory()) throw new Error('Pi 工作目录不存在');
    this.locate();
    mkdirSync(this.config.settings.pi_config_dir, { recursive: true, mode: 0o700 });
    // Loading Pi is deferred: a missing/broken Pi build must not stop the inbox service.
    const { RpcClient } = await import('@earendil-works/pi-coding-agent');
    if (this.closed) throw new Error('Pi 会话已关闭');
    const settings = this.config.settings;
    const args = ['--session-dir', this.config.sessionDir,
      ...(this.ref.session_file ? ['--session', this.ref.session_file] : ['--session-id', this.ref.session_id]),
      ...(settings.extensions ?? []).flatMap(path => ['--extension', path])];
    this.rpc = new RpcClient({ cliPath: this.config.cliPath, cwd: this.config.cwd,
      env: { PI_CODING_AGENT_DIR: settings.pi_config_dir }, provider: settings.provider, model: settings.model, args });
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
      const state = await this.getState();
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
      if (this.ref.session_file && !existsSync(this.ref.session_file)) throw new Error('原 Pi 会话文件缺失，已停止派发');
      if (state.sessionFile && existsSync(state.sessionFile)) {
        const file = resolve(state.sessionFile);
        if (this.ref.session_file && file !== resolve(this.ref.session_file)) throw new Error('Pi 会话文件路径发生变化，已停止派发');
        if (header(file).id !== this.ref.session_id) throw new Error('Pi 持久化文件身份不匹配');
        this.ref.session_file = file;
      }
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
    if (!this.ref.session_file) return new Set();
    const { parseSessionEntries } = await import('@earendil-works/pi-coding-agent');
    const entries = parseSessionEntries(readFileSync(this.ref.session_file, 'utf8'));
    const texts = new Set<string>();
    for (const entry of entries) {
      if (entry.type !== 'message' || entry.message.role !== 'user') continue;
      const content = entry.message.content;
      texts.add(typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join(''));
    }
    return texts;
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
