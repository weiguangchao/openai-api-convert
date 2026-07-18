import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startBridge, type Upstream } from '../src/server.js';

type SmokeEvent = {
  type?: unknown;
  response?: { id?: unknown };
  item?: { type?: unknown; call_id?: unknown; name?: unknown };
};
type CodexRunner = (args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal) => Promise<void>;
type CodexVersionRunner = (codexBin: string, env: NodeJS.ProcessEnv, timeoutMs?: number, signal?: AbortSignal) => Promise<string>;

export const PINNED_CODEX_VERSION = '0.144.5';
export const DIRECT_PROBE_TIMEOUT_MS = 90_000;
export const CODEX_SCENARIO_TIMEOUT_MS = 180_000;
export const RELEASE_PREFLIGHT_TIMEOUT_MS = 900_000;

export type ReleaseSmokeOptions = {
  apiKey: string;
  upstreams: Upstream[];
  model?: string;
  codexBin?: string;
  runCodex?: CodexRunner;
  getCodexVersion?: CodexVersionRunner;
  deadlineAt?: number;
  signal?: AbortSignal;
};

export type CodexProtocolFixtureOptions = {
  model: string;
  codexBin?: string;
  runCodex?: CodexRunner;
  getCodexVersion?: CodexVersionRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const boundedTimeout = (maximum: number, deadlineAt: number | undefined) => {
  if (deadlineAt === undefined) return maximum;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('Release preflight timed out');
  return Math.min(maximum, remaining);
};

const readEvents = (body: string): SmokeEvent[] => [...body.matchAll(/^data: (.+)$/gm)].map((match) => {
  try { return JSON.parse(match[1]) as SmokeEvent; }
  catch { throw new Error('Bridge returned an invalid SSE event'); }
});

const assertSemanticCompletion = (events: SmokeEvent[], scenario: string) => {
  const types = events.map((event) => event.type);
  if (types[0] !== 'response.created' || types.at(-1) !== 'response.completed' || types.filter((type) => type === 'response.completed').length !== 1
    || types.some((type) => typeof type !== 'string' || type.startsWith('chat.') || type === 'response.failed' || type === 'response.incomplete')) {
    throw new Error(`${scenario} [codex-cli ${PINNED_CODEX_VERSION}] did not complete semantically (events=${types.join(',') || 'none'})`);
  }
};

const scenarioFailure = (scenario: string, detail: string, events: Array<{ type?: unknown }> = []) => new Error(
  `${scenario} [codex-cli ${PINNED_CODEX_VERSION}] ${detail} (events=${events.map((event) => event.type).join(',') || 'none'})`,
);

const responseId = (events: SmokeEvent[], scenario: string) => {
  const id = events.find((event) => event.type === 'response.completed')?.response?.id;
  if (typeof id !== 'string' || !id) throw new Error(`${scenario} did not return a Response ID`);
  return id;
};

const requirePinnedCodexVersion = async (codexBin: string, getCodexVersion: CodexVersionRunner, timeoutMs = CODEX_SCENARIO_TIMEOUT_MS, signal?: AbortSignal) => {
  const version = (await getCodexVersion(codexBin, { PATH: process.env.PATH ?? '' }, timeoutMs, signal)).match(/\bcodex-cli\s+([^\s]+)/)?.[1];
  if (version !== PINNED_CODEX_VERSION) throw new Error(`Codex CLI smoke requires codex-cli ${PINNED_CODEX_VERSION}`);
};

const codexExecArgs = (codexBin: string, provider: string, model: string, baseUrl: string, dir: string) => [
  codexBin, 'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--disable', 'multi_agent', '--disable', 'apps', '-C', dir,
  '-c', `model_provider=${JSON.stringify(provider)}`,
  '-c', `model=${JSON.stringify(model)}`,
  '-c', `model_providers.${provider}.name=${JSON.stringify('Response Bridge smoke')}`,
  '-c', `model_providers.${provider}.base_url=${JSON.stringify(baseUrl)}`,
  '-c', `model_providers.${provider}.env_key=${JSON.stringify('BRIDGE_API_KEY')}`,
  '-c', `model_providers.${provider}.wire_api=${JSON.stringify('responses')}`,
];

const closeServer = async (server: Server | undefined) => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
};

const protocolFunctionFrames = [
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_exec_command', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' } }] } }] })}\r\n\r\n`,
  'data: [DONE]\r\n\r\n',
].join('');

const protocolTextFrames = [
  'data: {"choices":[{"delta":{"content":"ack"}}]}\r\n\r\n',
  'data: [DONE]\r\n\r\n',
].join('');

export const runCodexProtocolFixture = async ({ model, codexBin = 'codex', runCodex = runCodexCli, getCodexVersion = readCodexVersion, timeoutMs = CODEX_SCENARIO_TIMEOUT_MS, signal }: CodexProtocolFixtureOptions) => {
  if (!model.trim()) throw new Error('Release Preflight Model is required');
  await requirePinnedCodexVersion(codexBin, getCodexVersion, timeoutMs, signal);
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-protocol-fixture-'));
  let upstream: Server | undefined;
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    upstream = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += String(chunk); });
      request.on('end', () => {
        const requestBody = JSON.parse(body) as { messages?: Array<{ role?: string }>; tools?: Array<{ function?: { name?: string } }> };
        const continued = requestBody.messages?.some((message) => message.role === 'tool') === true;
        const hasExecCommand = requestBody.tools?.some((tool) => tool.function?.name === 'exec_command') === true;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (!continued && hasExecCommand) response.end(protocolFunctionFrames);
        else if (continued) response.end(protocolTextFrames);
        else response.end('data: [DONE]\r\n\r\n');
      });
    });
    await new Promise<void>((resolve, reject) => upstream!.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Codex Protocol Fixture did not bind a TCP port');
    bridge = await startBridge({
      apiKey: 'codex-protocol-fixture-key',
      upstreams: [{
        baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'codex-protocol-fixture-upstream-key',
        capabilities: { functionTools: true, parallelToolCalls: true },
      }],
      statePath: join(dir, 'state.db'),
      ...(process.env.RELEASE_SMOKE_DEBUG === '1' ? { logging: { level: 'debug' as const } } : {}),
    });
    const codexHome = join(dir, 'codex');
    await mkdir(codexHome);
    const provider = 'response-bridge-protocol-fixture';
    const responseCount = bridge.state.responses().length;
    const eventCount = bridge.state.events().length;
    try {
      await runCodex([
        ...codexExecArgs(codexBin, provider, model, `${bridge.url}/v1`, dir),
        '-m', model,
        'Run pwd, then reply with a short acknowledgement.',
      ], { PATH: process.env.PATH ?? '', CODEX_HOME: codexHome, BRIDGE_API_KEY: 'codex-protocol-fixture-key' }, timeoutMs, signal);
    } catch {
      throw scenarioFailure('Codex Protocol Fixture', 'execution failed', bridge.state.events().slice(eventCount));
    }
    const responses = bridge.state.responses().slice(responseCount);
    const events = bridge.state.events().slice(eventCount).map((event) => event.type);
    if (responses.filter((response) => response.status === 'completed').length !== 2
      || events.filter((type) => type === 'response.completed').length !== 2
      || !events.includes('response.function_call_arguments.done')
      || events.some((type) => type === 'response.failed' || type === 'response.incomplete' || type.startsWith('chat.'))) {
      throw new Error(`Codex Protocol Fixture [codex-cli ${PINNED_CODEX_VERSION}] did not complete a native tool loop (events=${events.join(',') || 'none'})`);
    }
  } finally {
    await bridge?.close();
    await closeServer(upstream);
    await rm(dir, { recursive: true, force: true });
  }
};

const runCodexCli: CodexRunner = async (args, env, timeoutMs, signal) => new Promise((resolve, reject) => {
  const child = spawn(args[0], args.slice(1), { env, stdio: 'ignore' });
  let settled = false;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) reject(error);
    else resolve();
  };
  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
    finish(new Error('Codex CLI smoke timed out'));
  }, timeoutMs);
  const abort = () => {
    child.kill('SIGTERM');
    finish(new Error('Release preflight interrupted'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  child.once('error', () => finish(new Error('Codex CLI could not start')));
  child.once('exit', (code) => finish(code === 0 ? undefined : new Error('Codex CLI smoke failed')));
});

const readCodexVersion: CodexVersionRunner = async (codexBin, env, timeoutMs = CODEX_SCENARIO_TIMEOUT_MS, signal) => new Promise((resolve, reject) => {
  const child = spawn(codexBin, ['--version'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  let settled = false;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) reject(error);
    else resolve(output);
  };
  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
    finish(new Error('Codex CLI version check timed out'));
  }, timeoutMs);
  const abort = () => {
    child.kill('SIGTERM');
    finish(new Error('Release preflight interrupted'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.once('error', () => finish(new Error('Codex CLI could not start')));
  child.once('exit', (code) => finish(code === 0 ? undefined : new Error('Codex CLI version check failed')));
});

export const runReleaseSmoke = async ({ apiKey, upstreams, model, codexBin = 'codex', runCodex = runCodexCli, getCodexVersion = readCodexVersion, deadlineAt, signal }: ReleaseSmokeOptions) => {
  if (!apiKey.trim()) throw new Error('BRIDGE_SMOKE_API_KEY is required');
  if (!upstreams.length) throw new Error('BRIDGE_SMOKE_UPSTREAM_POOL must not be empty');
  if (typeof model !== 'string' || !model.trim()) throw new Error('Release Preflight Model is required');
  if (!upstreams.some(({ capabilities }) => capabilities?.functionTools === true && capabilities.parallelToolCalls === true)) {
    throw new Error('Codex CLI smoke requires Function Tool and parallel Tool Calling support');
  }
  await requirePinnedCodexVersion(codexBin, getCodexVersion, boundedTimeout(CODEX_SCENARIO_TIMEOUT_MS, deadlineAt), signal);
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-smoke-'));
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    bridge = await startBridge({
      apiKey, upstreams, statePath: join(dir, 'state.db'),
      ...(process.env.RELEASE_SMOKE_DEBUG === '1' ? { logging: { level: 'debug' as const } } : {}),
    });
    const runningBridge = bridge;
    const directResponse = async (body: Record<string, unknown>, scenario: string) => {
      const timeoutMs = boundedTimeout(DIRECT_PROBE_TIMEOUT_MS, deadlineAt);
      let response: Response;
      try {
        response = await fetch(`${runningBridge.url}/v1/responses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, stream: true, ...body }),
          signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw scenarioFailure(scenario, 'timed out');
      }
      if (response.status !== 200) throw scenarioFailure(scenario, `failed (status=${response.status})`);
      const events = readEvents(await response.text());
      assertSemanticCompletion(events, scenario);
      return events;
    };
    await directResponse({ input: 'Reply with a short acknowledgement.' }, 'Bridge text Direct Probe');
    const webSearchEvents = await directResponse({
      input: 'Search the web and reply with a short acknowledgement.',
      tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' }, include: ['web_search_call.action.sources'],
    }, 'Bridge Web Search Direct Probe');
    if (webSearchEvents.some((event) => event.type === 'response.web_search_call.in_progress')) {
      throw scenarioFailure('Bridge Web Search Direct Probe', 'forged a Hosted Web Search call', webSearchEvents);
    }
    const runFunctionProbe = async (parallel: boolean) => {
      const names = parallel ? ['release_smoke_parallel_one', 'release_smoke_parallel_two'] : ['release_smoke_single'];
      const first = await directResponse({
        input: parallel ? 'Call both probe tools in parallel.' : 'Call the probe tool.',
        tools: names.map((name) => ({
          type: 'function', name, description: 'Release preflight probe',
          parameters: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false },
        })),
        ...(parallel ? { parallel_tool_calls: true } : { tool_choice: { type: 'function', name: names[0] } }),
      }, parallel ? 'Bridge parallel Function Direct Probe' : 'Bridge single Function Direct Probe');
      const calls = first.flatMap((event) => event.type === 'response.output_item.done' && event.item?.type === 'function_call'
        && typeof event.item.call_id === 'string' && typeof event.item.name === 'string'
        ? [{ callId: event.item.call_id, name: event.item.name }] : []);
      if (calls.length !== names.length || names.some((name) => !calls.some((call) => call.name === name))) {
        throw scenarioFailure(parallel ? 'Bridge parallel Function Direct Probe' : 'Bridge single Function Direct Probe', 'did not return the declared Function Tools', first);
      }
      await directResponse({
        previous_response_id: responseId(first, parallel ? 'Bridge parallel Function Direct Probe' : 'Bridge single Function Direct Probe'),
        input: calls.map((call) => ({ type: 'function_call_output', call_id: call.callId, output: `release preflight result for ${call.name}` })),
      }, parallel ? 'Bridge parallel Function continuation' : 'Bridge single Function continuation');
    };
    await runFunctionProbe(false);
    await runFunctionProbe(true);

    const provider = 'response-bridge-smoke';
    const codexHome = join(dir, 'codex');
    await mkdir(codexHome);
    const codexArgs = (withWebSearch: boolean) => [
      ...codexExecArgs(codexBin, provider, model, `${runningBridge.url}/v1`, dir),
      ...(withWebSearch ? ['-c', 'web_search="live"'] : []),
      '-m', model, withWebSearch ? 'Search the web and reply with a short acknowledgement.' : 'Reply with a short acknowledgement.',
    ];
    const runCodexScenario = async (withWebSearch: boolean) => {
      const responseCount = runningBridge.state.responses().length;
      const eventCount = runningBridge.state.events().length;
      try {
        await runCodex(codexArgs(withWebSearch), { PATH: process.env.PATH ?? '', CODEX_HOME: codexHome, BRIDGE_API_KEY: apiKey }, boundedTimeout(CODEX_SCENARIO_TIMEOUT_MS, deadlineAt), signal);
      } catch {
        throw scenarioFailure(withWebSearch ? 'Codex Web Search Smoke' : 'Codex baseline Smoke', 'execution failed');
      }
      const codexResponses = runningBridge.state.responses().slice(responseCount);
      const codexEvents = runningBridge.state.events().slice(eventCount).map((event) => event.type);
      if (!codexResponses.some((response) => response.status === 'completed')
        || codexEvents.filter((type) => type === 'response.completed').length !== 1
        || codexEvents.some((type) => type === 'response.failed' || type === 'response.incomplete' || type.startsWith('chat.'))) {
        throw new Error(`Codex CLI [codex-cli ${PINNED_CODEX_VERSION}] did not complete a Bridge Response (responses=${codexResponses.map((response) => response.status).join(',') || 'none'}; events=${codexEvents.join(',') || 'none'})`);
      }
      if (codexEvents.includes('response.web_search_call.in_progress')) throw scenarioFailure(withWebSearch ? 'Codex Web Search Smoke' : 'Codex baseline Smoke', 'forged a Hosted Web Search call', codexEvents.map((type) => ({ type })));
    };
    await runCodexScenario(false);
    await runCodexScenario(true);
  } finally {
    await bridge?.close();
    await rm(dir, { recursive: true, force: true });
  }
};
