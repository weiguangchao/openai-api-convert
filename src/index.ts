import { loadBridgeConfiguration } from './config.ts';
import { startBridge } from './server.ts';

const bridge = await startBridge(await loadBridgeConfiguration());
bridge.log('info', 'bridge_started');
