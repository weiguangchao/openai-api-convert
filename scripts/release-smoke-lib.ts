import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startBridge, type Upstream } from '../src/server.ts';

type SmokeEvent = { type?: unknown };
type CodexRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<void>;

export type ReleaseSmokeOptions = {
  apiKey: string;
  upstreams: Upstream[];
  model?: string;
  codexBin?: string;
  runCodex?: CodexRunner;
};

const readEvents = (body: string): SmokeEvent[] => [...body.matchAll(/^data: (.+)$/gm)].map((match) => {
  try { return JSON.parse(match[1]) as SmokeEvent; }
  catch { throw new Error('Bridge returned an invalid SSE event'); }
});

const runCodexCli: CodexRunner = async (args, env) => new Promise((resolve, reject) => {
  const child = spawn(args[0], args.slice(1), { env, stdio: 'ignore' });
  child.once('error', () => reject(new Error('Codex CLI could not start')));
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Codex CLI smoke failed')));
});

export const runReleaseSmoke = async ({ apiKey, upstreams, model = 'gpt-4.1', codexBin = 'codex', runCodex = runCodexCli }: ReleaseSmokeOptions) => {
  if (!apiKey.trim()) throw new Error('BRIDGE_SMOKE_API_KEY is required');
  if (!upstreams.length) throw new Error('BRIDGE_SMOKE_UPSTREAM_POOL must not be empty');
  if (!model.trim()) throw new Error('BRIDGE_SMOKE_MODEL must not be empty');
  if (!upstreams.some(({ capabilities }) => capabilities?.functionTools === true && capabilities.parallelToolCalls === true)) {
    throw new Error('Codex CLI smoke requires Function Tool and parallel Tool Calling support');
  }
  if (!upstreams.some(({ wireApi, capabilities }) => wireApi === 'responses'
    && capabilities?.functionTools === true
    && capabilities.parallelToolCalls === true
    && capabilities.webSearch === true)) {
    throw new Error('Codex CLI web search smoke requires a native Responses upstream with Hosted Web Search support');
  }
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-smoke-'));
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    bridge = await startBridge({ apiKey, upstreams, statePath: join(dir, 'state.db') });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model, stream: true, input: 'Search the web and reply with a short acknowledgement.',
        tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' }, include: ['web_search_call.action.sources'],
      }),
    });
    if (response.status !== 200) throw new Error('Bridge direct smoke failed');
    const events = readEvents(await response.text());
    const types = events.map((event) => event.type);
    if (types[0] !== 'response.created' || types.at(-1) !== 'response.completed' || types.filter((type) => type === 'response.completed').length !== 1) {
      throw new Error('Bridge direct smoke did not complete semantically');
    }
    if (types.some((type) => typeof type !== 'string' || type.startsWith('chat.'))) throw new Error('Bridge leaked a non-Responses event');
    if (!types.includes('response.web_search_call.in_progress')) throw new Error('Bridge direct smoke did not execute Hosted Web Search');

    const responseCount = bridge.state.responses().length;
    const eventCount = bridge.state.events().length;
    const provider = 'response-bridge-smoke';
    const codexHome = join(dir, 'codex');
    await mkdir(codexHome);
    const args = [
      codexBin, 'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--disable', 'multi_agent', '--disable', 'apps', '-c', 'web_search="live"', '-C', dir,
      '-c', `model_provider=${JSON.stringify(provider)}`,
      '-c', `model=${JSON.stringify(model)}`,
      '-c', `model_providers.${provider}.name=${JSON.stringify('Response Bridge smoke')}`,
      '-c', `model_providers.${provider}.base_url=${JSON.stringify(`${bridge.url}/v1`)}`,
      '-c', `model_providers.${provider}.env_key=${JSON.stringify('BRIDGE_API_KEY')}`,
      '-c', `model_providers.${provider}.wire_api=${JSON.stringify('responses')}`,
      '-m', model, 'Search the web and reply with a short acknowledgement.',
    ];
    await runCodex(args, { PATH: process.env.PATH ?? '', CODEX_HOME: codexHome, BRIDGE_API_KEY: apiKey });
    const codexResponses = bridge.state.responses().slice(responseCount);
    const codexEvents = bridge.state.events().slice(eventCount).map((event) => event.type);
    if (!codexResponses.some((response) => response.status === 'completed')
      || codexEvents.filter((type) => type === 'response.completed').length !== 1) {
      throw new Error('Codex CLI did not complete a Bridge Response');
    }
    if (!codexEvents.includes('response.web_search_call.in_progress')) throw new Error('Codex CLI did not execute Hosted Web Search');
  } finally {
    await bridge?.close();
    await rm(dir, { recursive: true, force: true });
  }
};
