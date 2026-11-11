import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { Connections } from './connections.ts';
import { createApp } from './server.ts';

process.umask(0o077);
const config = loadConfig(resolve(process.argv[2] ?? process.env.ADAPTOR_CONFIG ?? 'localdeploy/adaptor/config.json'));
const store = new Store(config.sqlite_path);
const connections = new Connections(store, config);
const server = createApp(config, store, connections);
const address = new URL(`http://${config.address}`);
server.listen(Number(address.port), address.hostname.replace(/^\[|\]$/g, ''), () => {
  connections.startAll();
  console.log(`Adaptor 已就绪：http://${config.address}`);
});
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true; connections.close();
  server.close(() => store.close());
  server.closeIdleConnections();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
