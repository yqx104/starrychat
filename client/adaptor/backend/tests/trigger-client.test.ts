import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { TriggerClient } from '../src/clients/trigger.ts';
import type { Delivery } from '../src/model/types.ts';

async function until(condition: () => boolean) {
  for (let i = 0; i < 120; i++) { if (condition()) return; await delay(25); }
  assert.fail('Condition did not become true');
}

async function fixture(t: TestContext) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address(); assert(typeof address === 'object');
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { server, url: `ws://127.0.0.1:${address.port}` };
}

test('Trigger transport leaves ACK to its caller and reconnects with refreshed credentials', async t => {
  const { server, url } = await fixture(t);
  const tokens: string[] = [];
  let acks = 0;
  server.on('connection', (socket, request) => {
    tokens.push(request.headers.authorization!);
    assert.equal(request.headers['x-adaptor-id'], 'local-adaptor');
    socket.on('message', data => {
      assert.deepEqual(JSON.parse(String(data)), { type: 'ack', message_id: 'message-a' });
      acks++;
    });
    socket.send(JSON.stringify({ type: 'ready', agent_id: 'a', token: 'renewed', expires_at: Date.now() + 3600000 }));
    socket.send(JSON.stringify({ type: 'delivery', agent_id: 'a', channel_id: 'direct', message: { message_id: 'message-a' } }));
  });
  let credentials = { token: 'initial', expires_at: Date.now() + 3600000 };
  const received: Delivery[] = [];
  const client = new TriggerClient({ url, adaptorId: 'local-adaptor', agentId: 'a', credentials: () => credentials,
    onReady: value => { credentials = value; }, onDelivery: item => { received.push(item); } });
  t.after(() => client.close()); client.start();
  await until(() => received.length === 1);
  await delay(25); assert.equal(acks, 0);
  client.ack(received[0].message.message_id);
  await until(() => acks === 1);
  for (const socket of server.clients) socket.terminate();
  await until(() => received.length === 2);
  assert.deepEqual(tokens, ['Bearer initial', 'Bearer renewed']);
  client.close();
  await delay(2100);
  assert.equal(tokens.length, 2, 'closing must cancel reconnects');
  assert.equal(acks, 1, 'redelivery must also wait for caller ACK');
});

test('Trigger transport rejects delivery before readiness and mismatched identities', async t => {
  const ready = { type: 'ready', agent_id: 'a', token: 'token', expires_at: Date.now() + 3600000 };
  const delivery = { type: 'delivery', agent_id: 'a', message: { message_id: 'message-a' } };
  for (const [name, frames] of [
    ['before ready', [delivery]],
    ['wrong ready identity', [{ ...ready, agent_id: 'other' }]],
    ['wrong delivery identity', [ready, { ...delivery, agent_id: 'other' }]],
  ] as const) {
    await t.test(name, async t => {
      const { server, url } = await fixture(t);
      let closed = false; let acks = 0; let deliveries = 0;
      server.on('connection', socket => {
        socket.on('message', () => { acks++; });
        socket.on('close', () => { closed = true; });
        for (const frame of frames) socket.send(JSON.stringify(frame));
      });
      const client = new TriggerClient({ url, adaptorId: 'local-adaptor', agentId: 'a',
        credentials: () => ({ token: 'token', expires_at: Date.now() + 3600000 }),
        onReady: () => {}, onDelivery: () => { deliveries++; } });
      t.after(() => client.close()); client.start();
      await until(() => closed);
      assert.equal(deliveries, 0); assert.equal(acks, 0);
    });
  }
});
