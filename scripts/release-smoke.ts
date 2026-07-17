import { runReleaseSmoke } from '../src/release-smoke.ts';
import type { Upstream } from '../src/server.ts';

const source = process.env.BRIDGE_SMOKE_UPSTREAM_POOL;
if (!source) throw new Error('BRIDGE_SMOKE_UPSTREAM_POOL is required');
let upstreams: unknown;
try { upstreams = JSON.parse(source); }
catch { throw new Error('BRIDGE_SMOKE_UPSTREAM_POOL must be JSON'); }
if (!Array.isArray(upstreams)) throw new Error('BRIDGE_SMOKE_UPSTREAM_POOL must be an array');

await runReleaseSmoke({
  apiKey: process.env.BRIDGE_SMOKE_API_KEY ?? '',
  upstreams: upstreams as Upstream[],
  model: process.env.BRIDGE_SMOKE_MODEL,
  codexBin: process.env.BRIDGE_SMOKE_CODEX_BIN,
});
console.log('Release smoke passed.');
