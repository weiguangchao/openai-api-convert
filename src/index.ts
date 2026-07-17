import { startBridge } from './server.ts';

const upstreams = JSON.parse(process.env.UPSTREAM_POOL ?? '[]');
const optionalNumber = (name: string) => process.env[name] === undefined ? undefined : Number(process.env[name]);
const statePolicy = {
  responseRetentionDays: optionalNumber('STATE_RESPONSE_RETENTION_DAYS'),
  attemptRetentionDays: optionalNumber('STATE_ATTEMPT_RETENTION_DAYS'),
  cleanupThresholdBytes: optionalNumber('STATE_CLEANUP_THRESHOLD_BYTES'),
  hardLimitBytes: optionalNumber('STATE_HARD_LIMIT_BYTES'),
};
const bridge = await startBridge({
  apiKey: process.env.BRIDGE_API_KEY ?? '',
  upstreams,
  statePath: process.env.STATE_STORE_PATH ?? './response-bridge.db',
  port: process.env.PORT ? Number(process.env.PORT) : undefined,
  statePolicy: Object.fromEntries(Object.entries(statePolicy).filter(([, value]) => value !== undefined)),
});
console.log(`Response Bridge listening at ${bridge.url}`);
