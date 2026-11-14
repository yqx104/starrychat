// Explicit, in-memory preview fixture. Never imported by the application.
import http from 'node:http';

// Canonical UUIDv7-shaped fixture values; these are never production identifiers.
const fixtureID = (n) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const now = Date.now();
const people = [
  { participant_id: fixtureID(1), kind: 'human', name: '小语', created_at: now - 86400000 * 20 },
  { participant_id: fixtureID(2), kind: 'agent', name: 'Mia', created_at: now - 86400000 * 10 },
  { participant_id: fixtureID(3), kind: 'agent', name: 'Atlas', created_at: now - 86400000 * 9 },
  { participant_id: fixtureID(4), kind: 'agent', name: 'Nova', created_at: now - 86400000 * 8 },
  { participant_id: fixtureID(5), kind: 'agent', name: 'Kai', created_at: now - 86400000 * 7 },
];
let conversations = [
  { conversation_id: fixtureID(101), kind: 'group', title: '产品协作小组', created_at: now - 86400000, dissolved_at: null, hidden: false },
  { conversation_id: fixtureID(102), kind: 'direct', title: 'Mia', created_at: now - 86400000 * 2, dissolved_at: null, hidden: false },
  { conversation_id: fixtureID(103), kind: 'group', title: '内容创作小组', created_at: now - 86400000 * 3, dissolved_at: null, hidden: false },
];
const members = new Map([[101, [1, 2, 3, 4]], [102, [1, 2]], [103, [1, 4, 5]]].map(([id, ids]) => [fixtureID(id), ids.map(fixtureID)]));
let nextConversation = 104, nextMessage = 10;
let demoAccount = null;
const cookie = 'im_token=demo-session; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800';
const authenticated = (req) => (req.headers.cookie ?? '').split(';').some((part) => part.trim() === 'im_token=demo-session') && demoAccount !== null;
let messages = [
  { message_id: fixtureID(1), conversation_id: fixtureID(101), sender_id: fixtureID(1), content: '大家早上好！今天我们一起把新版本的方向梳理一下。', created_at: now - 3600000 * 3, mentioned_agent_ids: [], quoted_message_id: null },
  { message_id: fixtureID(2), conversation_id: fixtureID(101), sender_id: fixtureID(3), content: '早上好，我已经整理好了核心需求。\n这次可以先从最常用的协作场景开始。', created_at: now - 3600000 * 2.7, mentioned_agent_ids: [], quoted_message_id: null },
  { message_id: fixtureID(3), conversation_id: fixtureID(101), sender_id: fixtureID(2), content: '我也看过了，信息层级可以再简洁一点，让大家更容易找到当前的重点。', created_at: now - 3600000 * 2.4, mentioned_agent_ids: [], quoted_message_id: fixtureID(2) },
  { message_id: fixtureID(4), conversation_id: fixtureID(101), sender_id: fixtureID(1), content: '这个思路不错！请帮我把关键步骤和下一步建议整理出来。', created_at: now - 3600000 * 2, mentioned_agent_ids: [fixtureID(2), fixtureID(3)], quoted_message_id: fixtureID(3) },
  { message_id: fixtureID(5), conversation_id: fixtureID(101), sender_id: fixtureID(4), content: '收到。我会补充一份内容结构，方便我们一起讨论 ✨', created_at: now - 3600000, mentioned_agent_ids: [], quoted_message_id: null },
  { message_id: fixtureID(6), conversation_id: fixtureID(102), sender_id: fixtureID(2), content: '你好！有什么想一起讨论的吗？', created_at: now - 86400000, mentioned_agent_ids: [], quoted_message_id: null },
  { message_id: fixtureID(7), conversation_id: fixtureID(103), sender_id: fixtureID(4), content: '今天的灵感整理好了，欢迎随时交流。', created_at: now - 86400000 * 2, mentioned_agent_ids: [], quoted_message_id: null },
];
const sequences = new Map();
const nextSeq = (conversationId) => { const seq = (sequences.get(conversationId) ?? 0) + 1; sequences.set(conversationId, seq); return seq; };
for (const item of messages) { item.created_at = Math.round(item.created_at); item.message_seq = nextSeq(item.conversation_id); }
const reply = (res, status, data) => { res.writeHead(status, status === 204 ? {} : { 'Content-Type': 'application/json; charset=utf-8' }); res.end(status === 204 ? '' : JSON.stringify(data)); };
const fail = (res, status, message) => reply(res, status, { error: { code: 'DEMO_ERROR', message } });
const readBody = async (req) => { let data = ''; for await (const chunk of req) data += chunk; return data ? JSON.parse(data) : {}; };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method;
    if (url.pathname === '/auth/register' && method === 'POST') {
      const body = await readBody(req);
      if (Object.keys(body).some((key) => !['username', 'password', 'name'].includes(key))) return fail(res, 400, '注册仅接受账号、密码和名称');
      if (demoAccount) return fail(res, 409, '真人账号已存在');
      demoAccount = { username: body.username, password: body.password }; people[0].name = body.name;
      return reply(res, 201, { participant: people[0] });
    }
    if (url.pathname === '/auth/login' && method === 'POST') {
      const body = await readBody(req);
      if (!demoAccount || demoAccount.username !== body.username || demoAccount.password !== body.password) return fail(res, 401, '账号或密码不正确');
      res.setHeader('Set-Cookie', cookie); return reply(res, 200, { participant: people[0], expires_at: Date.now() + 604800000 });
    }
    if (url.pathname === '/auth/me' && method === 'GET') {
      if (!authenticated(req)) return fail(res, 401, '请先登录');
      res.setHeader('Set-Cookie', cookie); return reply(res, 200, { participant: people[0] });
    }
    if (url.pathname === '/auth/logout' && method === 'POST') {
      res.setHeader('Set-Cookie', 'im_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); return reply(res, 204);
    }
    if (!authenticated(req)) return fail(res, 401, '请先登录');
    res.setHeader('Set-Cookie', cookie);
    if (url.pathname === '/participants' && method === 'GET') return reply(res, 200, { participants: url.searchParams.has('kind') ? people.filter((p) => p.kind === url.searchParams.get('kind')) : people });
    if (url.pathname === '/conversations' && method === 'GET') return reply(res, 200, { conversations });
    if (url.pathname === '/conversations' && method === 'POST') {
      const body = await readBody(req); const conversation = { conversation_id: fixtureID(nextConversation++), kind: 'group', title: body.title, created_at: Date.now(), dissolved_at: null, hidden: false };
      conversations = [conversation, ...conversations]; members.set(conversation.conversation_id, [fixtureID(1), ...body.agent_ids]); return reply(res, 201, { conversation });
    }
    if (url.pathname === '/conversations/direct' && method === 'POST') {
      const body = await readBody(req); let conversation = conversations.find((c) => c.kind === 'direct' && members.get(c.conversation_id)?.includes(body.agent_id));
      if (!conversation) { conversation = { conversation_id: fixtureID(nextConversation++), kind: 'direct', title: people.find((p) => p.participant_id === body.agent_id)?.name ?? null, created_at: Date.now(), dissolved_at: null, hidden: false }; conversations = [conversation, ...conversations]; members.set(conversation.conversation_id, [fixtureID(1), body.agent_id]); }
      conversation.hidden = false;
      return reply(res, 200, { conversation });
    }
    const match = url.pathname.match(/^\/conversations\/([0-9a-f-]{36})(?:\/(dissolve|members|messages|visibility)(?:\/([0-9a-f-]{36}))?)?$/);
    if (!match) return fail(res, 404, '未找到接口');
    const id = match[1]; const conversation = conversations.find((c) => c.conversation_id === id);
    if (!conversation) return fail(res, 404, '未找到会话');
    if (!match[2] && method === 'GET') return reply(res, 200, { conversation });
    if (match[2] === 'visibility' && method === 'PATCH') { const body = await readBody(req); if (typeof body.hidden !== 'boolean') return fail(res, 400, 'hidden 必须是布尔值'); conversation.hidden = body.hidden; return reply(res, 200, { conversation }); }
    if (!match[2] && method === 'PATCH') { const body = await readBody(req); conversation.title = body.title; return reply(res, 200, { conversation }); }
    if (match[2] === 'dissolve' && method === 'POST') { conversation.dissolved_at = Date.now(); return reply(res, 200, { conversation }); }
    if (match[2] === 'members' && method === 'GET') return reply(res, 200, { members: people.filter((p) => members.get(id)?.includes(p.participant_id)) });
    if (match[2] === 'members' && method === 'POST') { const body = await readBody(req); const member = people.find((p) => p.participant_id === body.participant_id); if (!member) return fail(res, 404, '未找到成员'); members.set(id, [...new Set([...(members.get(id) ?? []), member.participant_id])]); return reply(res, 200, { member }); }
    if (match[2] === 'members' && method === 'DELETE') { members.set(id, (members.get(id) ?? []).filter((p) => p !== match[3])); return reply(res, 204); }
    if (match[2] === 'messages' && method === 'GET') {
      let list = messages.filter((m) => m.conversation_id === id).sort((a, b) => a.message_seq - b.message_seq); const limit = Number(url.searchParams.get('limit') ?? 50); const before = url.searchParams.get('before_seq'); const after = url.searchParams.get('after_seq');
      if (before) list = list.filter((m) => m.message_seq < Number(before)); if (after) list = list.filter((m) => m.message_seq > Number(after));
      const has_more = list.length > limit; list = after ? list.slice(0, limit) : list.slice(-limit); return reply(res, 200, { messages: list, has_more });
    }
    if (match[2] === 'messages' && method === 'POST') {
      if (conversation.dissolved_at !== null) return fail(res, 422, '群聊已解散');
      const body = await readBody(req); const message = { message_seq: nextSeq(id), message_id: fixtureID(nextMessage++), conversation_id: id, sender_id: fixtureID(1), content: body.content, mentioned_agent_ids: body.mentioned_agent_ids ?? [], quoted_message_id: body.quoted_message_id ?? null, created_at: Date.now() }; messages.push(message); return reply(res, 201, { message });
    }
    return fail(res, 405, '不支持此操作');
  } catch { return fail(res, 500, '演示服务处理失败'); }
});
const port = Number(process.env.IM_DEMO_PORT ?? 4178);
server.listen(port, '127.0.0.1', () => console.log(`Demo fixture: http://127.0.0.1:${port} (in-memory example data)`));
