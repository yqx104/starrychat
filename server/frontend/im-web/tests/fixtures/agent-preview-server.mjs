// Temporary in-memory fixture for Agent management and identity switching; never imported by the app.
import http from 'node:http';

// Canonical UUIDv7-shaped fixture values; these are never production identifiers.
const fixtureID = (n) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const stamp = Date.now();
const humans = [
  { participant_id: fixtureID(1), kind: 'human', name: '示例用户甲', created_at: stamp, username: 'sample.one', password: 'fixture-pass-one' },
  { participant_id: fixtureID(2), kind: 'human', name: '示例用户乙', created_at: stamp, username: 'sample.two', password: 'fixture-pass-two' },
];
let agents = [
  { participant_id: fixtureID(11), kind: 'agent', name: '示例助手甲', username: 'sample.agent-a', owner_participant_id: fixtureID(1), created_at: stamp },
  { participant_id: fixtureID(12), kind: 'agent', name: '示例助手乙', username: 'sample.agent-b', owner_participant_id: fixtureID(2), created_at: stamp },
];
let nextId = 13;
const chats = [];
const publicHuman = ({ participant_id, kind, name, created_at }) => ({ participant_id, kind, name, created_at });
const body = async (req) => { let data = ''; for await (const chunk of req) data += chunk; return data ? JSON.parse(data) : {}; };
const reply = (res, status, value) => { res.writeHead(status, status === 204 ? {} : { 'Content-Type': 'application/json' }); res.end(status === 204 ? '' : JSON.stringify(value)); };
const error = (res, status, message) => reply(res, status, { error: { code: 'FIXTURE_ERROR', message } });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const cookie = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith('im_token=fixture-'));
    const human = humans.find((item) => cookie === `im_token=fixture-${item.participant_id}`);
    if (url.pathname === '/auth/login' && req.method === 'POST') {
      const input = await body(req); const found = humans.find((item) => item.username === input.username && item.password === input.password);
      if (!found) return error(res, 401, '账号或密码不正确');
      res.setHeader('Set-Cookie', `im_token=fixture-${found.participant_id}; Path=/; HttpOnly; SameSite=Lax`);
      return reply(res, 200, { participant: publicHuman(found), expires_at: Date.now() + 604800000 });
    }
    if (url.pathname === '/auth/logout' && req.method === 'POST') { res.setHeader('Set-Cookie', 'im_token=; Path=/; HttpOnly; Max-Age=0'); return reply(res, 204); }
    if (!human) return error(res, 401, '请先登录');
    if (url.pathname === '/auth/me') return reply(res, 200, { participant: publicHuman(human) });
    if (url.pathname === '/participants') return reply(res, 200, { participants: [publicHuman(human), ...agents.filter((agent) => agent.owner_participant_id === human.participant_id).map(publicHuman)] });
    const ownedChats = chats.filter((chat) => chat.ownerId === human.participant_id);
    if (url.pathname === '/conversations' && req.method === 'GET') return reply(res, 200, { conversations: ownedChats.map((chat) => chat.conversation) });
    if (url.pathname === '/conversations/direct' && req.method === 'POST') {
      const input = await body(req); const chat = ownedChats.find((item) => item.agentId === input.agent_id);
      if (!chat) return error(res, 404, '未找到单聊');
      chat.conversation.hidden = false;
      return reply(res, 200, { conversation: chat.conversation });
    }
    const chatMatch = url.pathname.match(/^\/conversations\/([0-9a-f-]{36})(?:\/(members|messages|visibility))?$/);
    if (chatMatch) {
      const chat = ownedChats.find((item) => item.conversation.conversation_id === chatMatch[1]);
      if (!chat) return error(res, 404, '未找到单聊');
      if (req.method === 'GET' && !chatMatch[2]) return reply(res, 200, { conversation: chat.conversation });
      if (req.method === 'GET' && chatMatch[2] === 'members') return reply(res, 200, { members: [publicHuman(human), publicHuman(agents.find((agent) => agent.participant_id === chat.agentId))] });
      if (req.method === 'GET' && chatMatch[2] === 'messages') return reply(res, 200, { messages: [], has_more: false });
      if (req.method === 'PATCH' && chatMatch[2] === 'visibility') { chat.conversation.hidden = (await body(req)).hidden; return reply(res, 200, { conversation: chat.conversation }); }
    }
    if (url.pathname === '/agents' && req.method === 'GET') return reply(res, 200, { agents: agents.filter((agent) => agent.owner_participant_id === human.participant_id) });
    if (url.pathname === '/agents' && req.method === 'POST') {
      const input = await body(req); const agent = { participant_id: fixtureID(nextId++), kind: 'agent', name: input.name, username: input.username, owner_participant_id: human.participant_id, created_at: Date.now() };
      const conversation = { conversation_id: fixtureID(nextId++), kind: 'direct', title: null, created_at: agent.created_at, dissolved_at: null, hidden: false };
      chats.push({ conversation, ownerId: human.participant_id, agentId: agent.participant_id });
      agents = [...agents, agent]; return reply(res, 201, { agent, conversation });
    }
    const match = url.pathname.match(/^\/agents\/([0-9a-f-]{36})$/);
    if (match && req.method === 'PATCH') {
      const agent = agents.find((item) => item.participant_id === match[1] && item.owner_participant_id === human.participant_id);
      if (!agent) return error(res, 404, '未找到 Agent');
      const input = await body(req); if (input.name !== undefined) agent.name = input.name; if (input.username !== undefined) agent.username = input.username;
      return reply(res, 200, { agent });
    }
    return error(res, 404, '未找到接口');
  } catch { return error(res, 500, '测试服务异常'); }
});
server.listen(4192, '127.0.0.1', () => console.log('Agent test fixture started on 127.0.0.1:4192.'));
