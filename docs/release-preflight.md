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
| Retention, capacity and operations | Cleanup safety, capacity-before-write, auth, readiness, metrics, logs and disconnect |

Run the real-upstream and Codex CLI preflight only with deployment credentials in the ignored `config.yaml`:

```sh
cp config.example.yaml config.yaml
# Fill both API keys and the upstream base URL in config.yaml.
npm test
```

The command starts an isolated Bridge and State Store, first verifies semantic Responses SSE directly, then runs ephemeral Codex with an isolated provider configuration. Codex's built-in web search is enabled; apps and multi-agent namespaces are disabled. It accepts any generated content; success requires a semantic `response.completed` from both direct and Codex requests without forged Hosted Web Search calls. The configured pool must explicitly support Function Tool and parallel Tool Calling. Hosted Web Search is always degraded per ADR 0003.
