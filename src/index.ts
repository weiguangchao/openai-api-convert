import { startBridge } from './server.ts';

const upstreams = JSON.parse(process.env.UPSTREAM_POOL ?? '[]');
const bridge = await startBridge({
  apiKey: process.env.BRIDGE_API_KEY ?? '',
  upstreams,
  statePath: process.env.STATE_STORE_PATH ?? './response-bridge.db',
  port: process.env.PORT ? Number(process.env.PORT) : undefined,
});
console.log(`Response Bridge listening at ${bridge.url}`);
