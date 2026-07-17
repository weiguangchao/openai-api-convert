# Release preflight

`npm test` is the Compatibility Fixture gate. It fixes the Responses request, optional Response Chain and Idempotency-Key, scripted Chat upstream, expected Responses SSE and State Store observations. It never asserts conversion internals or generated model text.

| Fixture group | Covered contract |
| --- | --- |
| `text-complete` | Text SSE, Chat request, event persistence and terminal state |
| `function-single`, `function-parallel` | Response Chain, call IDs, arguments and order |
| `custom-supported`, `custom-incompatible`, `parallel-incompatible` | Native routing or pre-stream rejection |
| `declared-capability-client-4xx` | Direct 4xx without failover |
| `idempotency-in-progress`, `idempotency-terminal`, `idempotency-failed` | Replay, atomic terminal state and conflict safety |
| `failover-before-output`, `failure-after-output`, `all-upstreams-fail` | Retry boundary and terminal failure |
| Retention, capacity and operations | Cleanup safety, capacity-before-write, auth, readiness, metrics, logs and disconnect |

Run the real-upstream and Codex CLI preflight only with deployment credentials:

```sh
export BRIDGE_SMOKE_API_KEY='local-bridge-key'
export BRIDGE_SMOKE_UPSTREAM_POOL='[{"baseUrl":"https://upstream.example/v1","apiKey":"...","capabilities":{"functionTools":true,"parallelToolCalls":true}}]'
export BRIDGE_SMOKE_MODEL='deployment-model'
npm run smoke
```

The command starts an isolated Bridge and State Store, first verifies semantic Responses SSE directly, then runs ephemeral Codex with an isolated provider configuration. Codex's built-in web search, apps and multi-agent namespaces are disabled for this MVP preflight. It accepts any generated content; success requires a semantic `response.completed` from both direct and Codex requests. The configured pool must explicitly support Function Tool and parallel Tool Calling. `BRIDGE_SMOKE_CODEX_BIN` optionally overrides `codex`.
