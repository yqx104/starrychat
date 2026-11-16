import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpConnection } from '../model/types.ts';
import { ConfigurationError } from '../model/errors.ts';
import { readPrivateConfig, writePrivateConfigs } from './files.ts';

export function configureMcp(directory: string, cwd: string, connections: McpConnection[]) {
  if (!connections.length) return;
  const config = readPrivateConfig(directory, 'mcp.json');
  const servers = config.mcpServers ?? {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new ConfigurationError('pi-config/mcp.json 的 mcpServers 必须是对象');
  const names = new Set(connections.map(connection => connection.name.replace(/-/g, '_')));
  if (names.size !== connections.length || connections.some(connection => !/^[a-zA-Z0-9_-]+$/.test(connection.name))) {
    throw new ConfigurationError('托管 MCP 名称无效或重复');
  }
  // Pi allows project config to override its agent config. A managed identity must not be shadowed.
  const projectPath = join(cwd, '.pi', 'mcp.json');
  if (existsSync(projectPath)) {
    let project: Record<string, unknown>;
    try { project = JSON.parse(readFileSync(projectPath, 'utf8')); }
    catch { throw new ConfigurationError('请检查工作目录 .pi/mcp.json，无法核对托管 MCP 配置'); }
    if (project?.mcpServers && Object.keys(project.mcpServers).some(name => names.has(name.replace(/-/g, '_')))) {
      throw new ConfigurationError('工作目录 .pi/mcp.json 不能覆盖 adaptor 托管的 MCP 服务');
    }
  }
  const updated = { ...servers } as Record<string, unknown>;
  for (const connection of connections) {
    let url: URL;
    try { url = new URL(connection.url); } catch { throw new ConfigurationError('托管 MCP 地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new ConfigurationError('托管 MCP 地址无效');
    if (Object.keys(updated).some(name => name !== connection.name && name.replace(/-/g, '_') === connection.name.replace(/-/g, '_'))) {
      throw new ConfigurationError('pi-config/mcp.json 存在冲突的托管 MCP 名称');
    }
    updated[connection.name] = { type: 'http', url: connection.url, headers: connection.headers ?? {}, exposure: 'direct', enabled: true };
  }
  writePrivateConfigs(directory, { 'mcp.json': { ...config, mcpServers: updated } });
}
