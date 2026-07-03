# Plan 1 — Architecture

Runtime: **Deno + TypeScript**. Deno's sandbox permissions give runtime-enforced isolation, `deno compile` gives single-binary agents, and containers stay small. Design lineage is deliberate (see Plan 4): Claude Code's permission grammar and harness discipline, OpenCode's server-first architecture and provider abstraction, Codex CLI's sandbox defaults.

## Core concepts

### Agent

The unit of everything: one identity, one job. Defined entirely in one YAML file:

- **identity** — nickname + description. **Users don't name agents; agents name themselves.** The config's `nickname` is the stable operator handle (compose service, logs, CLI, session keys). On first boot the agent performs a one-time naming ritual — one LLM call given its job description — and the chosen name persists in SQLite for life, surviving restarts. The agent presents itself by its own name (e.g. signing Discord replies); the operator addresses it by nickname. A fresh volume means a new memory and a new self — the agent renames itself.
- **model** — provider + model id (+ fallbacks, roles)
- **system prompt** — the job description
- **tools** — natives, skills, MCP servers, custom TS
- **triggers** — what wakes it up
- **permissions** — what it may touch (deny-by-default)
- **memory** — what persists between events
- **limits** — max steps, max cost per run

### The Loop

Two loops, one nested in the other:

```
outer loop (the service):
  wait for trigger event
    → assemble context (event + relevant memory)
    → inner loop (the reasoning):
        LLM call → tool calls → results → LLM call → … until done
    → deliver result back through the trigger's channel
  → go idle
```

The **outer loop** makes a Looped agent a service, not a script. The **inner loop** is one flat tool-use loop — single message history, `while(tool_calls)`, deterministic harness around a thin model core. No graphs inside an agent; composition happens between agents. Inner-loop discipline (all of it exists because unattended + cheap models exercise these paths daily):

- **Budgets as dead-man's switches**: `limits.max_steps` and `limits.max_cost` end runs with typed errors (`error_max_steps`, `error_max_cost`).
- **Forgiving loop**: tool arguments validated against JSON Schema, validation errors fed back to the model for self-repair; provider retries classified (rate-limit vs overloaded); model fallback chain from config.
- **Context discipline**: compact tool results, output token caps, lean history. Compaction is v1 scope for long-lived sessions: prune old tool outputs first, then summarize; reserve token headroom; anti-thrash cutoff.
- **Read-only parallelism**: tools carry a `readOnly` hint; read-only calls run concurrently, mutating calls serialize.

### Triggers

Pluggable event sources declared in config — the framework's core differentiator (no incumbent ships trigger-in-config; see Plan 4). A trigger connects outward, converts happenings into events, and provides the reply channel.

v1 triggers:
- **discord** — gateway connection; channel/mention filters; replies in-thread
- **webhook** — HTTP endpoint with bearer auth; responds with result or ack+callback
- **cron** — schedule expression; results go to a configured sink

```ts
interface Trigger {
  start(emit: (event: AgentEvent) => void): Promise<void>;
  reply(event: AgentEvent, result: AgentResult): Promise<void>;
  stop(): Promise<void>;
}
```

Later:
- **chat** — an embedded product-chat trigger: a frontend (e.g. app.looped.sh's Looped Chat) consumes the agent's HTTP/SSE surface directly, with per-app-user sessions and authenticated access. Needed for dogfooding the framework inside Looped's product (Plan 5).
- **a2a** — Agent2Agent protocol endpoint + generated agent card, making Looped agents callable by the broader ecosystem.

### Tools — four sources, one interface

Uniform shape (name + JSON-Schema input + async execute + `readOnly` hint), honest hierarchy:

1. **Natives** — the universal escape hatches, shipped with the framework, always permission-gated: `run_bash`, `http_request`, `read_file`, `write_file`. Between `run_bash` and `http_request`, *every* CLI and *every* API is reachable — MCP is an option, never a gate.
2. **Skills** — markdown know-how packages (+ optional helper scripts) that make the natives effective: how to drive a CLI or API well. **Skills carry knowledge, never capability** — a skill cannot grant permissions; the agent.yaml permission block remains the sole authority, so a malicious skill is just misleading documentation with a permission-bounded blast radius (the inverse of the ClawHub disaster). Progressive disclosure: one description line in context until invoked — the cheap-model-friendly way to integrate anything.
3. **MCP servers** — declared in config (stdio command or HTTP endpoint), tools namespaced `mcp__server__tool` so permission rules cover them uniformly. Hygiene: `include:` filtering (expose 3 tools from a 40-tool server), deferred schema loading, output token caps, health/reconnect supervision (long-running agents can't use per-session MCP lifecycles).
4. **Custom TypeScript tools** — a `.ts` file exporting a typed tool definition, referenced from config. Full control.

The default recipe for "use any API/CLI": **custom image provides the binary, skill provides the knowledge, permissions provide the safety.**

### Provider adapter

Owned, thin, three layers (OpenCode's proven blueprint):

1. **Model metadata** — consume the open models.dev registry for context limits/costs/capabilities rather than hardcoding.
2. **Adapters** behind one streaming interface (`complete()`: messages, tool defs, structured-output mode, stream). v1: **Anthropic** and **OpenAI-compatible** (co-equal citizens — the latter covers gpt-5.4-mini, Ollama, vLLM, proxies).
3. **Config overrides** — `base_url`, `api_key_env`, custom model entries; any OpenAI-compatible endpoint is just config.

Plus: **model roles** (`model.small:` for summarization/compaction/labels — route the boring calls to the cheapest model), per-agent fallback chains, structured-output/JSON-mode support (cheap models are far more reliable when boxed in), and per-call token/cost accounting into the audit trail.

### Memory / persistence

- **SQLite on a mounted volume** — the canonical store: sessions, messages, runs, tool calls, permission denials, token cost (the audit trail the platform later aggregates; see Plan 5).
- **Markdown workspace** — optional human-readable agent memory (`MEMORY.md` pattern): greppable, editable by the operator, loaded per config.
- Sessions keyed by the trigger's conversation identity (Discord thread, webhook correlation id). Compaction per the inner-loop rules above.

### Permissions

Deny by default. Declared once, enforced always, **never prompted**:

- Rule grammar: `Tool(specifier)` — `bash(gh *)` with compound-command splitting, `net(api.github.com)`, `read(/workspace/**)`, `mcp__github__create_issue`. Evaluated **deny → ask → allow, first match wins, no specificity reordering** (a broad deny beats a narrow allow — predictability over cleverness in a security boundary). Config gets a published JSON Schema.
- **`ask` cannot exist at runtime.** Config validation resolves every `ask` to: deny, a declared fallback, or an **escalation event** — the undecided action is emitted to a configured channel (webhook, Discord message to an operator) and denies on timeout. Escalation-as-event fits the event-driven model; a waiting prompt does not (OpenCode's headless `ask` literally hangs the server — see Plan 4).
- A permission denial is a normal tool result the model can adapt to, not a crash.

**Three-layer enforcement** (defense in depth — declarative rules decide *intent*, sandboxes enforce *capability*):

1. **Deno sandbox** — permissions compile to `--allow-net=<hosts>`, `--allow-read/write=<paths>`, `--allow-run=<cmds>`. Tight for agents using only natives-without-bash, skills-via-http, MCP.
2. **Container** — the real boundary once `run_bash` exists (a spawned subprocess escapes Deno's sandbox entirely). Hardened base image: non-root, read-only rootfs with explicit writable workspace, no capabilities, never mount docker.sock. **Network egress off by default**, opened per the config's net allowlist (container network policy / egress proxy) — Codex's defaults, adopted.
3. **MicroVM isolation** (gVisor/Firecracker) — hosted-platform tier only; single-tenant self-hosting doesn't need it (Plan 5).

### Secrets

- Config holds **references, never values**: `${GITHUB_TOKEN}` / `api_key_env:`. Configs stay committable.
- Resolution order: env var → `/run/secrets/<name>` (Compose file secrets) → external providers later (Vault/SOPS/1Password/cloud) as a platform-tier feature.
- **Never in model context**: credentials are injected server-side at tool-execution time; the model sees that a tool exists, never the PAT.
- **Scoped tool environments**: `run_bash` and MCP servers receive only the env vars the config explicitly grants them — no ambient inheritance of the agent process env.
- Log/transcript redaction of known secret values.

### Multi-agent (later)

Composition over orchestration: an agent exposed *as a tool* to another agent (`agent_call`), or reachable via A2A. No graphs, no planners, no shared scratchpads. Sketch only; no v1 commitment.

## Config

YAML-first, one file per agent. Current sketch of the MVP agent (see Plan 2 for the annotated version and the skill-based variant):

```yaml
nickname: issue-bot                  # operator handle; the agent names itself on first boot
description: Turns team Discord messages into GitHub issues.

model:
  provider: openai-compatible        # gpt-5.4-mini-class by default — see Plan 0 principle 9
  id: gpt-5.4-mini
  small: gpt-5.4-mini                # role for summaries/compaction

system_prompt: |
  You manage GitHub issues for the team. When someone describes work,
  create a well-titled issue with a clear body and reply with the link.

triggers:
  - type: discord
    channels: ["issues"]

skills:
  - ./skills/gh-issues.md            # teaches the gh CLI; binary comes from the image

permissions:
  net: [discord.com, gateway.discord.gg, api.github.com]
  run: [gh]

env:
  GITHUB_TOKEN: ${GITHUB_TOKEN}      # reference, resolved at runtime, scoped to gh

memory:
  scope: thread

limits:
  max_steps: 10
  max_cost: 0.10
```

A programmatic `defineAgent()` variant is planned later; YAML stays canonical.

## Runtime & deployment

- **One agent per container; a fleet is a compose file.**
- **The Dockerfile is the environment; the YAML is the agent.** Official base image `looped/agent` (Deno + framework + natives, hardened, minimal — no browser, no extras: Plan 0 principle 8). Custom environments are one layer away:

```dockerfile
FROM looped/agent
RUN apk add --no-cache github-cli
```

- **Server-first**: every agent exposes an HTTP surface — health, sessions, runs, SSE event stream — with an OpenAPI spec. The CLI, `looped dev`, the future hub, and the hosted platform are all thin clients of the same API. Loopback-bound by default, auth token required even locally.
- CLI: `looped init` (scaffold), `looped dev` (hot-reload local run), `looped run agent.yaml` (the container entrypoint).

```
docker run -v ./agent.yaml:/agent/agent.yaml --env-file .env looped/agent
```

**Distribution** — three channels, no npm:

1. **Docker image** (`looped/agent`) — the primary channel; the framework ships inside it. Users deploy YAML, not packages.
2. **CLI** — `deno compile`d binary via install script.
3. **JSR `@looped/af`** — the library, for custom-tool authors, `defineAgent()` later, and embedders. JSR's npm-compat layer covers Node consumers (`npx jsr add @looped/af`); we do not maintain an npm presence.

## Repo structure

This repo is a **monorepo** (Deno workspaces), with documentation as a first-class package from day one:

```
plans/          — this plan series
packages/
  core/         — agent loop, config loader, providers, permissions, memory
  triggers/     — discord, webhook, cron (separately importable)
  cli/          — looped init/dev/run
docs/           — the documentation site (versioned with the code it documents)
images/         — base image Dockerfile(s)
examples/       — complete agents (issue-bot first), each a copy-paste starting point
skills/         — first-party skills (gh-issues, ...)
```

Docs rule: a feature PR that doesn't touch `docs/` isn't done. Examples are executable documentation — CI runs them.

## Open questions

- YAML ↔ `defineAgent()`: does YAML compile to the programmatic form internally?
- MCP-servers-as-containers: sibling containers vs separate compose services?
- Egress enforcement mechanism: per-container network policy vs a shared egress proxy sidecar?
- Streaming results through triggers (progressive Discord edits) or final-result-only for v1?
- Run traces: bespoke JSONL in SQLite vs OpenTelemetry from day one?
- Eval harness (typed task I/O + `looped test`) — post-MVP, but the cheap-model story eventually needs it.
- Self-naming edge cases: should agency/client deployments get a policy option to present the nickname externally instead of the self-chosen name (brand control)? And is volume-reset-means-new-name the right call, or should the name be exportable/restorable with memory?
