import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

// Local MCP credentials are independent of IM's rolling bearer tokens and of any harness process.
export class McpCredentials {
  private tokens = new Map<string, string>();
  private path: string;

  constructor(path: string) {
    this.path = path;
    if (!existsSync(path)) return;
    try {
      if (!lstatSync(path).isFile()) throw new Error();
      const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      for (const [id, token] of Object.entries(data)) {
        if (!/^[a-zA-Z0-9_-]+$/.test(id) || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error();
        this.tokens.set(id, token);
      }
    } catch { throw new Error('MCP 凭据文件损坏，请检查 SQLite 旁的 .mcp-credentials.json 文件'); }
  }

  forAgent(agentId: string): string {
    const existing = this.tokens.get(agentId);
    if (existing) return existing;
    const token = randomBytes(32).toString('hex');
    const next = new Map(this.tokens).set(agentId, token);
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(Object.fromEntries(next)) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
      this.tokens = next;
    } finally { rmSync(temporary, { force: true }); }
    return token;
  }

  identify(token: string): string | undefined {
    if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
    const supplied = Buffer.from(token, 'hex');
    for (const [id, expected] of this.tokens) {
      if (timingSafeEqual(supplied, Buffer.from(expected, 'hex'))) return id;
    }
    return undefined;
  }
}
