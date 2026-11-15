import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/config.ts';
import { APIError } from '../model/errors.ts';

export function agentDirectories(config: Config, agentId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) throw new APIError(400, 'INVALID_AGENT_ID', 'Agent ID 无效');
  const root = join(config.agent_root, agentId);
  return { cwd: join(root, 'workspace'), pi_config_dir: join(root, 'pi-config'), sessions_dir: join(root, 'sessions') };
}

export function prepareAgentDirectories(config: Config, agentId: string) {
  const directories = agentDirectories(config, agentId);
  try {
    for (const path of Object.values(directories)) mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch { throw new APIError(500, 'AGENT_DIRECTORY_UNAVAILABLE', '无法创建 Agent 目录，请检查 agent_root 和目录权限'); }
  return directories;
}
