# Release preflight

`npm run test:unit` is the Compatibility Fixture gate. It fixes the Responses request, optional Response Chain and Idempotency-Key, scripted Chat upstream, expected Responses SSE and State Store observations. It never asserts conversion internals or generated model text.

| Fixture group | Covered contract |
| --- | --- |
| `text-complete` | Text SSE, Chat request, event persistence and terminal state |
| `function-single`, `function-parallel` | Response Chain, call IDs, arguments and order |
| `custom-supported`, `custom-incompatible`, `parallel-incompatible` | Capability routing or pre-stream rejection |
| `web-search` degradation | Hosted Web Search removed, unavailable hint, forced choice → `auto`, no forged results |
| `declared-capability-client-4xx` | Direct 4xx without failover |
| `idempotency-in-progress`, `idempotency-terminal`, `idempotency-failed` | Replay, atomic terminal state and conflict safety |
| `failover-before-output`, `failure-after-output`, `all-upstreams-fail` | Retry boundary and terminal failure |
| Retention, capacity and operations | Cleanup safety, capacity-before-write, auth, readiness, logs and disconnect |

`npm test` is the complete release gate: it runs every Compatibility Fixture before the real-Codex preflight. The preflight has three deliberately separate layers:

| Layer | Required paths |
| --- | --- |
| Codex Protocol Fixture | Fixed `codex-cli 0.144.5`, a scripted Completion upstream, and a real `exec_command` call plus tool-result continuation |
| Live Direct Responses Probe | Text, Hosted Web Search degradation, single Function Tool continuation, and a parallel Function Tool continuation with both outputs |
| Live Codex Smoke | Fixed `codex-cli 0.144.5` through the deployed Completion upstream: a baseline request and a request with built-in Web Search enabled |

The Protocol Fixture is deterministic and proves Codex's client-side tool protocol. The live paths prove the configured deployment integration, but do not require the model to choose a tool. All successful paths require the structural Codex Smoke Evidence; generated text and call IDs are not assertions.

The fixture also verifies Codex's `store:false` Inline Tool Replay: a paired `function_call` and `function_call_output` without `previous_response_id` must become the corresponding Completion assistant tool call and tool message.

The live Direct Responses Function Probes use dedicated no-side-effect tools. The single-call probe forces a named Function Tool; the parallel probe requires two named Function Tools in one parallel round and returns fixed harness-owned outputs for both. A missing call, a non-parallel result, or a failed continuation fails the gate.

The live preflight is fail-closed: it does not retry timeouts, `429`s, connection failures, or any non-completed Response. Its failure report identifies the scenario, pinned Codex version, and a redacted semantic-event sequence so an operator can reproduce the failed boundary without treating a retry as evidence of health.

Each Direct Responses Probe has a 90-second hard deadline, each Codex scenario has a 180-second hard deadline, and the complete `npm test` gate has a 15-minute deadline. A deadline failure terminates the relevant child process, cleans up the isolated state, and fails the gate without retrying.

By default, failure diagnostics contain the scenario, pinned Codex version, and a redacted structural event summary; they never retain raw Codex stdout/stderr, complete requests, or SSE payloads. The isolated directory is always removed. Set `RELEASE_SMOKE_DEBUG=1` explicitly for local diagnosis to enable Bridge debug traffic logs; do not enable it in routine CI.

Run the real-upstream portions only with deployment credentials in the ignored `config.test.yaml`:

```sh
cp config.dev.yaml config.test.yaml
npm test
```

`config.test.yaml` must explicitly declare `releasePreflight.model`; the preflight has no model fallback and reports the selected name. DeepSeek V4's default Thinking mode rejects forced `tool_choice`; configure that upstream with `thinking.type: disabled` so the declared single-Function probe remains deterministic. Other providers omit this provider-native option.

The command starts an isolated Bridge and State Store, then runs each layer with an isolated provider configuration. Codex's built-in web search is enabled; apps and multi-agent namespaces are disabled. The configured pool must explicitly support Function Tool and parallel Tool Calling. Hosted Web Search is always degraded per ADR 0003.
