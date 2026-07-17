import { loadBridgeConfiguration } from '../src/config.ts';
import { runReleaseSmoke } from './release-smoke-lib.ts';

const configuration = await loadBridgeConfiguration();

await runReleaseSmoke({
  apiKey: configuration.apiKey,
  upstreams: configuration.upstreams,
});
console.log('Release smoke passed.');
