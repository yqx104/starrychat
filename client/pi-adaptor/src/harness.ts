import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Harness, OpenConfig } from '@starrychat/adaptor-contracts';
import { PiSession } from './session/session.ts';
import { piDirectories, piSettings, readRuntimeConfig, runtimeSettings, saveRuntimeConfig } from './config/runtime.ts';
import { parseNativeRef } from './session/history.ts';

export const defaultPiCliPath = fileURLToPath(new URL('../../../agents/pi/upstream/packages/coding-agent/dist/bundle/rpc-entry.js', import.meta.url));

function validateSession(config: OpenConfig) {
  const settings = piSettings(config.settings);
  const ref = parseNativeRef(config.nativeRef);
  if (settings.pi_config_dir !== piDirectories(config).pi_config_dir ||
      ref?.session_file && dirname(ref.session_file) !== config.sessionDir) {
    throw new Error('Pi 目录与 agent_root 不一致，请停服并迁移现有目录和数据库路径');
  }
}

export function createPiHarness(options: { cliPath?: string } = {}): Harness {
  return {
    id: 'pi',
    readConfig: readRuntimeConfig,
    validateConfig(input) { runtimeSettings(input); },
    saveConfig: saveRuntimeConfig,
    validateSession,
    createSession(config) {
      validateSession(config);
      let ref = parseNativeRef(config.nativeRef);
      if (!ref) {
        if (!config.allowCreate) throw new Error('已有输入可能被处理，但缺少 Pi 会话引用；请先核对待恢复输入');
        ref = { session_id: randomUUID(), session_file: null };
      }
      return new PiSession({ cliPath: options.cliPath ?? defaultPiCliPath,
        cwd: config.cwd, sessionDir: config.sessionDir,
        settings: { ...piSettings(config.settings), pi_config_dir: piDirectories(config).pi_config_dir },
        nativeRef: ref, allowCreate: config.allowCreate, mcpServers: config.mcpServers });
    },
  };
}
