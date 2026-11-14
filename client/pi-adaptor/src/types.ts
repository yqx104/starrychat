export interface NativeRef { session_id: string; session_file: string | null }
export interface PiSettings { pi_config_dir: string; provider?: string; model?: string; extensions?: string[] }
export interface OpenConfig {
  cliPath: string; cwd: string; sessionDir: string; settings: PiSettings;
  nativeRef: NativeRef; allowCreate: boolean;
}
export type Disposition = 'started' | 'queued' | 'handled';
export interface Input { id: number; text: string }
export interface Receipt { inputId: number; disposition: Disposition }
export interface SessionState {
  nativeRef: NativeRef; status: 'idle' | 'busy' | 'compacting';
  pending: number; model: { provider: string; id: string } | null;
}
export interface SessionEvent {
  type: 'text' | 'tool' | 'queue' | 'activity' | 'error' | 'state';
  text?: string; tool?: string; phase?: string; pending?: number; state?: SessionState;
}
export interface Session {
  open(): Promise<SessionState>;
  sendInput(input: Input): Promise<Receipt>;
  onEvent(listener: (event: SessionEvent) => void): () => void;
  getState(): Promise<SessionState>;
  abort(): Promise<void>;
  close(): Promise<void>;
  persistedInputs(): Promise<Set<string>>;
}
export type SessionFactory = (config: OpenConfig) => Session;

export class InputError extends Error {
  kind: 'retryable' | 'rejected' | 'unknown';
  constructor(kind: InputError['kind'], message: string) { super(message); this.kind = kind; }
}

// Transport diagnostics can contain a subprocess's entire stderr. Never expose it through HTTP.
export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('. Stderr:')[0].slice(0, 1500);
}
