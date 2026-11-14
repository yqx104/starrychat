// Protocol fixture, executed by the real upstream RpcClient. No model or external service is used.
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const arg = name => process.argv[process.argv.indexOf(name) + 1];
const config = existsSync('fixture.json') ? JSON.parse(readFileSync('fixture.json', 'utf8')) : {};
const file = process.argv.includes('--session') ? arg('--session') : join(arg('--session-dir'), `${arg('--session-id')}.jsonl`);
const sessionId = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).id : arg('--session-id');
let busy = false; let transient = false; let queue = []; let activeChecks = 0;
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const response = (command, data) => emit({ type: 'response', command: command.type, id: command.id, success: true, data });
const fail = (command, error) => emit({ type: 'response', command: command.type, id: command.id, success: false, error });
function persist(text) {
  if (config.noPersist) return;
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd: process.cwd(), timestamp: new Date().toISOString() }) + '\n');
  appendFileSync(file, JSON.stringify({ type: 'message', id: randomUUID().slice(0, 8), parentId: null, timestamp: new Date().toISOString(),
    message: { role: 'user', content: text, timestamp: Date.now() } }) + '\n');
}
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  appendFileSync('commands.jsonl', JSON.stringify({ ...command, pid: process.pid, activeChecks }) + '\n');
  if (command.type === 'get_state') {
    activeChecks++;
    setTimeout(() => {
      activeChecks--;
      response(command, { sessionId: config.wrongIdentity ? randomUUID() : sessionId, sessionFile: file, isStreaming: busy, isCompacting: false,
        pendingMessageCount: queue.length, model: { provider: 'fixture', id: 'fixture', headers: { authorization: 'must-not-be-exposed' } } });
    }, config.stateDelayMs ?? 0);
  } else if (command.type === 'prompt') {
    if (command.message.includes('TRANSIENT') && !transient) { transient = true; return fail(command, 'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.'); }
    if (command.message.includes('REJECT')) return fail(command, 'No API key found for fixture.');
    if (command.message.includes('CRASH')) { if (config.persistBeforeCrash) persist(command.message); process.exit(7); }
    if (command.message.includes('HANDLED')) return response(command, { disposition: 'handled' });
    const disposition = busy ? 'queued' : 'started';
    if (busy) queue.push(command.message); else { persist(command.message); busy = true; emit({ type: 'agent_start' }); }
    setTimeout(() => response(command, { disposition }), config.receiptDelayMs ?? 0);
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'fixture output' } });
    emit({ type: 'tool_execution_start', toolName: 'read', args: { secret: 'must-not-be-exposed' } });
    emit({ type: 'queue_update', steering: queue, followUp: [] });
    emit({ type: 'response', id: 'late-unmatched-request', command: 'prompt', success: true, data: { secret: 'must-not-be-exposed' } });
    if (config.endWithoutSettled) { busy = false; emit({ type: 'agent_end', willRetry: true }); }
    if (config.settleDelayMs) setTimeout(() => {
      for (const text of queue) persist(text);
      queue = []; busy = false; emit({ type: 'agent_end', willRetry: false }); emit({ type: 'agent_settled', aborted: false });
    }, config.settleDelayMs);
  } else if (command.type === 'abort') {
    busy = false; emit({ type: 'agent_settled', aborted: true }); response(command, {});
  } else response(command, {});
});
if (config.exitAfterMs) setTimeout(() => process.exit(9), config.exitAfterMs);
process.on('SIGTERM', () => process.exit(0));
