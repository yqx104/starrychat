import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface Config {
  address: string;
  im_base_url: string;
  trigger_ws_url: string;
  adaptor_id: string;
  sqlite_path: string;
}

export function loadConfig(path: string): Config {
  const config = JSON.parse(readFileSync(path, 'utf8')) as Config;
  for (const key of ['address', 'im_base_url', 'trigger_ws_url', 'adaptor_id', 'sqlite_path'] as const) {
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
  return config;
}
