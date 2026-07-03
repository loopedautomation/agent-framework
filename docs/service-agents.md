# Service agents: triggers, permissions, and the audit trail

Status: covers M2. An agent with `triggers:` in its config runs as a long-lived service — the outer loop. Without them, `af run` gives you the interactive REPL.

## Webhook trigger

```yaml
triggers:
  - type: webhook
    # path: /            (default)
    # port: 8080         (default)
    token_env: WEBHOOK_TOKEN   # required — bearer auth, deny by default
```

Call it:

```sh
curl -s localhost:8080 \
  -H "authorization: Bearer $WEBHOOK_TOKEN" \
  -H "content-type: application/json" \
  -d '{"input": "run: echo hello", "conversation_id": "demo"}'
```

The response is the run result: `{"status": "ok", "reply": "...", "steps": 2, "cost_usd": 0.0001}`. Pass the same `conversation_id` to continue a conversation (with `memory.scope: thread`); omit it for one-shot runs.

`token_env` is required — an unauthenticated endpoint contradicts deny-by-default. The token resolves at startup, and a missing env var fails then, not on the first request.

## Cron trigger

```yaml
triggers:
  - type: cron
    schedule: "0 9 * * 1"        # every Monday 09:00
    prompt: Post a summary of open issues.
```

Each tick runs the agent with `prompt` as input. Results are logged and recorded in the run history (a configurable result sink is planned).

## Permissions

Deny by default: an agent with no `permissions:` block can touch nothing.

```yaml
permissions:
  net: [api.github.com, "*.internal.example.com"]  # http_request + hosts
  run: [gh, echo]                                  # executables run_bash may spawn
  read: [/workspace]                               # readable path prefixes
  write: [/workspace/out]                          # writable path prefixes
```

- **Tools follow permissions**: `run_bash` only exists for the agent if `run:` grants something; `http_request` only if `net:` does. No dead tool schemas burning context.
- **Denials are tool results**, not crashes — the model sees `permission denied: run access to "curl" is not in the agent's permissions.run allowlist` and adapts.
- **Static analysis over hope**: `run_bash` extracts every executable from pipes/chains and checks each; command substitution (`$(...)`, backticks) is rejected outright because it can't be checked.
- **Scoped environments**: subprocesses receive only the env vars the config's `env:` block grants (plus PATH/HOME) — never the agent process's ambient environment.
- **Layer 1 compilation**: `af flags agent.yaml` prints the Deno sandbox flags the config compiles to, e.g. `--allow-net=api.github.com --allow-run=gh`. The container is layer 2.

## Secrets

Config holds references, never values:

```yaml
env:
  GITHUB_TOKEN: ${GITHUB_TOKEN}
```

Resolution order: process env var → `/run/secrets/<NAME>` (Docker Compose file secrets). Missing references fail at startup. Secrets are injected into tools server-side and never enter the model's context.

## Persistence & audit

Each agent owns one SQLite file (default `.looped/<nickname>.db`; override with `LOOPED_DATA_DIR`), holding:

- **sessions/messages** — conversation history per `conversation_id` (when `memory.scope: thread`)
- **runs** — every run: trigger, input, status, steps, tokens, cost, timestamps
- **audit** — every permission decision, allowed and denied

This is the "logged, reversible, and approval-gated" story: what did the agent do, what did it cost, and what did it try that we said no to.

## The M2 demo

[`examples/echo-service`](../examples/echo-service/agent.yaml) is the whole story in one file: webhook-triggered, may run `echo` and nothing else. Ask it to `curl` something and read the denial in the reply — then find the same denial in the audit table.
