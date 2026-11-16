import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface Config {
  address: string;
  im_base_url: string;
  trigger_ws_url: string;
  adaptor_id: string;
  sqlite_path: string;
  agent_root: string;
  pi_cli_path?: string;
}

export function loadConfig(path: string): Config {
  const config = JSON.parse(readFileSync(path, 'utf8')) as Config;
  for (const key of ['address', 'im_base_url', 'trigger_ws_url', 'adaptor_id', 'sqlite_path', 'agent_root'] as const) {
    if (typeof config[key] !== 'string' || !config[key]) throw new Error(`配置缺少 ${key}`);
  }
  const address = new URL(`http://${config.address}`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) || !address.port) {
    throw new Error('本机 adaptor 必须监听环回地址和明确的端口');
  }
  if (!['http:', 'https:'].includes(new URL(config.im_base_url).protocol) ||
      !['ws:', 'wss:'].includes(new URL(config.trigger_ws_url).protocol)) throw new Error('服务地址协议无效');
  config.im_base_url = config.im_base_url.replace(/\/$/, '');
  config.sqlite_path = resolve(dirname(path), config.sqlite_path);
  if (!isAbsolute(config.agent_root)) throw new Error('agent_root 必须是绝对路径');
  if ('data_root' in config) throw new Error('data_root 已由 agent_root 替代，请停服并迁移现有 Agent 目录和数据库路径');
  config.agent_root = resolve(config.agent_root);
  if (config.pi_cli_path !== undefined && (typeof config.pi_cli_path !== 'string' || !config.pi_cli_path)) throw new Error('配置 pi_cli_path 无效');
  if (config.pi_cli_path) config.pi_cli_path = resolve(dirname(path), config.pi_cli_path);
  return config;
}
