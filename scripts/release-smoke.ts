import { loadBridgeConfiguration } from '../src/config.js';
import { runReleaseSmoke } from './release-smoke-lib.js';

const configuration = await loadBridgeConfiguration(process.argv[2] ?? 'config.test.yaml');

await runReleaseSmoke({
  apiKey: configuration.apiKey,
  upstreams: configuration.upstreams,
  model: 'deepseek-v4-flash',
});
console.log('Release smoke passed.');
