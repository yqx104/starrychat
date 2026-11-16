import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../config/config.ts';
import { APIError } from '../model/errors.ts';
import { ImClient, imId } from '../clients/im.ts';
import { McpCredentials } from '../repository/mcp-credentials.ts';
import { Store } from '../repository/store.ts';

const instructions = '以当前认证的 IM Agent 身份查阅和发送消息。消息历史来自 IM，包含未触发本 Agent 的消息。' +
  '所有消息操作都显式指定 conversation_id。群聊需要 mentioned_agent_ids 才会唤起其他 Agent；引用或正文中的 @文字不会替代它。' +
  '发送成功只表示 IM 已保存，不表示对方已收到或执行。SEND_RESULT_UNKNOWN 表示可能已发送，应核实历史，不要自动重发。';

export class ImMcp {
  private credentials: McpCredentials;
  private url: string;
  private store: Store;
  private config: Config;

  constructor(store: Store, config: Config) {
    this.store = store; this.config = config;
    this.credentials = new McpCredentials(`${config.sqlite_path}.mcp-credentials.json`);
    this.url = `http://${config.address}/mcp`;
  }

  // Filled with the actual listening port before any harness starts (also supports port 0 in tests).
  listenAt(port: number) {
    const url = new URL(this.url); url.port = String(port); this.url = url.href;
  }

  connection(agentId: string) {
    if (!this.store.agent(agentId)) throw new APIError(404, 'NOT_FOUND', 'Agent 不存在');
    return { name: 'starrychat', url: this.url,
      headers: { Authorization: `Bearer ${this.credentials.forAgent(agentId)}` } };
  }

  authenticate(token: string) {
    const agentId = this.credentials.identify(token);
    if (!agentId || !this.store.agent(agentId)) throw new APIError(401, 'MCP_AUTH_REQUIRED', 'MCP 访问凭据无效');
    return agentId;
  }

  createServer(agentId: string) {
    const im = new ImClient(this.config.im_base_url, () => {
      const agent = this.store.agent(agentId);
      if (!agent) throw new APIError(401, 'MCP_AUTH_REQUIRED', 'IM Agent 不存在');
      return { token: agent.token, expires_at: agent.credential_expires_at };
    }, (previous, token, expiresAt) => this.store.renewCredentials(agentId, previous, token, expiresAt));
    const server = new McpServer({ name: 'starrychat-im', version: '1.0.0' }, { instructions });
    const invoke = async (operation: () => Promise<Record<string, unknown>>): Promise<CallToolResult> => {
      try {
        const result = await operation();
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const detail = error instanceof APIError ? { code: error.code, message: error.message } :
          { code: 'INTERNAL_ERROR', message: 'IM 工具调用失败' };
        const result = { error: detail };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
    };
    const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
    server.registerTool('im_whoami', {
      description: '验证当前 IM 登录，返回代表的 Agent 身份；身份由 MCP 访问凭据固定。',
      inputSchema: z.object({}).strict(), annotations: read,
    }, (_, extra) => invoke(() => im.whoami(extra.signal)));
    server.registerTool('im_list_conversations', {
      description: '列出当前身份加入的会话，包含 hidden 和 dissolved_at 状态。单聊 title 可为空，用 im_get_conversation 查看成员。',
      inputSchema: z.object({}).strict(), annotations: read,
    }, (_, extra) => invoke(() => im.listConversations(extra.signal)));
    server.registerTool('im_get_conversation', {
      description: '获取会话详情及成员名单；使用成员 participant_id 进行 @，不要根据显示名猜测身份。',
      inputSchema: z.object({ conversation_id: imId }).strict(), annotations: read,
    }, ({ conversation_id }, extra) => invoke(() => im.getConversation(conversation_id, extra.signal)));
    server.registerTool('im_list_participants', {
      description: '列出当前身份可见的真人和 Agent，可按 kind 筛选。返回稳定 ID 和显示名；可见不代表已加入某个群。',
      inputSchema: z.object({ kind: z.enum(['human', 'agent']).optional() }).strict(), annotations: read,
    }, ({ kind }, extra) => invoke(() => im.listParticipants(kind, extra.signal)));
    server.registerTool('im_list_messages', {
      description: '查询 IM 完整会话历史，默认最近 20 条，最多 50 条，结果按 message_seq 升序。' +
        'before_seq 向前翻页，after_seq 拉取新增，两者互斥；has_more 对应当前查询方向，序号仅在本会话内有效。',
      inputSchema: z.object({ conversation_id: imId, limit: z.number().int().min(1).max(50).default(20),
        before_seq: z.number().int().positive().optional(), after_seq: z.number().int().nonnegative().optional() }).strict(), annotations: read,
    }, ({ conversation_id, ...query }, extra) => invoke(() => im.listMessages(conversation_id, query, extra.signal)));
    server.registerTool('im_send_message', {
      description: '以当前 Agent 身份发送文本。quoted_message_id 引用同一会话的消息；mentioned_agent_ids 显式 @ 群成员以唤起 Agent。' +
        '发送成功表示 IM 已保存；SEND_RESULT_UNKNOWN 时先查历史核实，禁止自动重发。',
      inputSchema: z.object({ conversation_id: imId, content: z.string().refine(value => !!value.trim(), '消息不能为空'),
        quoted_message_id: imId.optional(), mentioned_agent_ids: z.array(imId).optional() }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, ({ conversation_id, ...input }, extra) => invoke(() => im.sendMessage(conversation_id, input, extra.signal)));
    return server;
  }
}
