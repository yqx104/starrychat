import type { McpConnection, SessionState } from '@starrychat/adaptor-contracts';

export interface NativeRef { session_id: string; session_file: string | null }
export interface PiSettings { pi_config_dir: string; extensions?: string[] }
export interface OpenConfig {
  cliPath: string; cwd: string; sessionDir: string; settings: PiSettings;
  nativeRef: NativeRef; allowCreate: boolean;
  mcpServers?: McpConnection[];
}
export type PiSessionState = SessionState & { nativeRef: NativeRef };
