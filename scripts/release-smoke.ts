import { loadBridgeConfiguration } from '../src/config.ts';
import { runReleaseSmoke } from './release-smoke-lib.ts';

const configuration = await loadBridgeConfiguration();

await runReleaseSmoke({
  apiKey: configuration.apiKey,
  upstreams: configuration.upstreams,
  model: 'glm-5.2',
});
console.log('Release smoke passed.');
