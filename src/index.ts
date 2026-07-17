import { loadBridgeConfiguration } from './config.ts';
import { log, startBridge } from './server.ts';

const bridge = await startBridge(await loadBridgeConfiguration());
log('info', 'bridge_started');
