export { ConfigurationError, InputError, errorMessage } from './errors.ts';

export interface McpConnection { name: string; url: string; headers?: Record<string, string> }
export interface Input { id: number; text: string }
// Acceptance is not task completion. Only handled inputs need no model-history recovery.
export type Disposition = 'started' | 'queued' | 'handled';
export interface Receipt { inputId: number; disposition: Disposition }
export interface SessionState {
  // JSON-serializable, owned and interpreted exclusively by the harness.
  nativeRef: unknown;
  status: 'idle' | 'busy' | 'compacting';
  pending: number; model: { provider: string; id: string } | null;
}
export interface SessionEvent {
  type: 'text' | 'tool' | 'queue' | 'activity' | 'error' | 'state';
  text?: string; tool?: string; phase?: string; pending?: number; state?: SessionState;
  fatal?: boolean;
}
export interface Session {
  // Available before open(), so the service can persist identity before starting a process.
  readonly nativeRef: unknown;
  open(): Promise<SessionState>;
  sendInput(input: Input): Promise<Receipt>;
  onEvent(listener: (event: SessionEvent) => void): () => void;
  getState(): Promise<SessionState>;
  abort(): Promise<void>;
  close(): Promise<void>;
  // May run after close(). Return only IDs proven durable; omitted IDs remain uncertain.
  recoverInputs(inputs: Input[]): Promise<Set<number>>;
}

export interface AgentContext { root: string; cwd: string }
export interface OpenConfig extends AgentContext {
  sessionDir: string; settings: unknown; nativeRef: unknown; allowCreate: boolean;
  mcpServers?: McpConnection[];
}
export interface RuntimeConfiguration {
  config: unknown;
  directories: Record<string, string>;
  configuration_issue: string | null;
  // Safe metadata for the harness-specific configuration form, never credentials.
  [key: string]: unknown;
}
export interface Harness {
  readonly id: string;
  readConfig(context: AgentContext, settings: unknown): RuntimeConfiguration;
  // Pure validation runs before lifecycle checks; saving runs only after edits are allowed.
  validateConfig(input: unknown): void;
  saveConfig(context: AgentContext, input: unknown, settings: unknown): unknown;
  // Check stored configuration/reference against the assigned directories without writing files.
  validateSession(config: OpenConfig): void;
  createSession(config: OpenConfig): Session;
}
