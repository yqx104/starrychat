import { resolve } from 'node:path';
import { loadConfig } from '../config/config.ts';
import { Store } from '../repository/store.ts';
import { Connections } from '../service/connections.ts';
import { createApp } from '../http/server.ts';
import { Sessions } from '../service/sessions.ts';
import { Agents } from '../service/agents.ts';
import { Dispatcher } from '../service/dispatch.ts';

process.umask(0o077);
const config = loadConfig(resolve(process.argv[2] ?? process.env.ADAPTOR_CONFIG ?? 'localdeploy/adaptor/config.json'));
const store = new Store(config.sqlite_path);
const sessions = new Sessions(store, config);
const dispatcher = new Dispatcher(store, sessions);
sessions.onReady = id => dispatcher.wake(id);
const connections = new Connections(store, config, id => dispatcher.wake(id));
const agents = new Agents(store, config, connections, sessions);
const server = createApp(config, agents, sessions, () => store.checkHealth());
const address = new URL(`http://${config.address}`);
server.listen(Number(address.port), address.hostname.replace(/^\[|\]$/g, ''), () => {
  connections.startAll();
  sessions.startAll(); dispatcher.start();
  console.log(`Adaptor 已就绪：http://${config.address}`);
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true; connections.close(); dispatcher.stop();
  const requestsClosed = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeIdleConnections();
  await sessions.close();
  await dispatcher.drain();
  await requestsClosed;
  store.close();
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
