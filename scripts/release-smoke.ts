import { loadBridgeConfiguration } from '../src/config.js';
import { CODEX_SCENARIO_TIMEOUT_MS, RELEASE_PREFLIGHT_TIMEOUT_MS, runCodexProtocolFixture, runReleaseSmoke } from './release-smoke-lib.js';

const configuration = await loadBridgeConfiguration(process.argv[2] ?? 'config.test.yaml');
const model = configuration.releasePreflight?.model;

if (!model) throw new Error('Configuration.releasePreflight.model is required for release preflight');
const configuredDeadline = Number(process.env.RELEASE_GATE_DEADLINE_AT);
const deadlineAt = Number.isFinite(configuredDeadline) && configuredDeadline > Date.now()
  ? configuredDeadline
  : Date.now() + RELEASE_PREFLIGHT_TIMEOUT_MS;
const cancellation = new AbortController();
process.once('SIGTERM', () => cancellation.abort());
const remainingCodexTimeout = () => {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('Release preflight timed out');
  return Math.min(CODEX_SCENARIO_TIMEOUT_MS, remaining);
};

await runCodexProtocolFixture({ model, timeoutMs: remainingCodexTimeout(), signal: cancellation.signal });

await runReleaseSmoke({
  apiKey: configuration.apiKey,
  upstreams: configuration.upstreams,
  model,
  deadlineAt,
  signal: cancellation.signal,
});
console.log('Release smoke passed.');
