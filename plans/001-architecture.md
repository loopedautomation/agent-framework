# Plan 1 — Architecture

Runtime: **Deno + TypeScript**. Deno's sandbox permissions give the framework runtime-enforced isolation for free, `deno compile` gives single-binary agents, and containers stay small.

## Core concepts

### Agent

An agent is the unit of everything: one identity, one job. Defined entirely in config:

- **identity** — name, description
- **model** — provider + model id
- **system prompt** — the job description
- **tools** — what it can do
- **triggers** — what wakes it up
- **permissions** — what it's allowed to touch
- **memory** — what it remembers between events

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

The **outer loop** is what makes a Looped agent a service rather than a script. The **inner loop** is the standard LLM tool-use iteration, capped by turn/step limits from config.

### Triggers

Pluggable event sources. A trigger connects to the outside world, converts happenings into events, and provides the reply channel for results.

v1 triggers:
- **discord** — gateway connection; filters by channel/mention; replies in-thread
- **webhook** — HTTP endpoint; responds with the run result or an ack + callback
- **cron** — schedule expression; fires with no reply channel (results go to a configured sink)

Trigger interface sketch (new triggers are additive, no core changes):

```ts
interface Trigger {
  start(emit: (event: AgentEvent) => void): Promise<void>;
  reply(event: AgentEvent, result: AgentResult): Promise<void>;
  stop(): Promise<void>;
}
```

### Tools

Three sources, one uniform interface (name + JSON-schema input + async execute):

1. **Native built-ins** — shipped with the framework: `run_bash`, `http_request`, `read_file`, `write_file`. Zero config to enable, always permission-gated.
2. **MCP servers** — any Model Context Protocol server declared in config (e.g. the GitHub MCP server for the MVP). This is the primary extension surface.
3. **Custom TypeScript tools** — a `.ts` file exporting a tool definition, referenced from config. The escape hatch.

### Provider adapter

A deliberately thin, owned interface — no third-party abstraction layer in the core:

```ts
interface Provider {
  complete(req: {
    model: string;
    system: string;
    messages: Message[];
    tools?: ToolDef[];
    stream?: boolean;
  }): Promise<Completion>; // text | tool_calls, usage
}
```

v1 adapters: **Anthropic** and **OpenAI-compatible** (which also covers Ollama, vLLM, most proxies). Selecting a provider is one config line.

### Memory / state

- Per-conversation history keyed by the trigger's conversation id (Discord thread, webhook correlation id).
- Persistence: **SQLite on a mounted volume** — fits one-agent-one-container, survives restarts, no external service.
- Context-window compaction (summarize old turns) is acknowledged future work, not v1.

### Permissions

Deny by default. Declared once in `agent.yaml`, never prompted at runtime:

- **Tool allowlist** — only listed tools exist for the agent.
- **Host allowlist** — which domains `http_request` (and MCP servers) may reach → compiles to `--allow-net=<hosts>`.
- **Command allowlist** — which executables `run_bash` may run → app-level gating (+ `--allow-run=<cmds>` where possible).
- **Filesystem scope** — readable/writable paths → `--allow-read`/`--allow-write`.

Two enforcement layers: the framework checks before executing a tool call (clear error back to the model, which can adapt), and the Deno sandbox backstops it at the OS level. A permission failure is a normal tool result, not a crash.

### Multi-agent (later)

Composition over orchestration: an agent can be exposed *as a tool* to another agent (`agent_call`). No graphs, no planners, no shared scratchpads — an agent that needs help calls a narrower agent the same way it calls any tool. Sketch only; no v1 commitment.

## Config

YAML-first. The MVP agent, in full (annotated version lives in Plan 2):

```yaml
name: issue-bot
description: Turns team Discord messages into GitHub issues.

model:
  provider: anthropic
  id: claude-sonnet-5

system_prompt: |
  You manage GitHub issues for the team. When someone describes work,
  create a well-titled issue with a clear body and reply with the link.

triggers:
  - type: discord
    channels: ["issues"]

tools:
  mcp:
    - name: github
      command: ["docker", "run", "-i", "ghcr.io/github/github-mcp-server"]
      env: { GITHUB_TOKEN: ${GITHUB_TOKEN} }

permissions:
  net: [discord.com, gateway.discord.gg, api.github.com]

memory:
  scope: thread
```

A programmatic `defineAgent()` (TypeScript config) variant is planned later for dynamic cases; YAML stays the canonical form.

## Runtime & deployment

- **One agent per container.** A fleet is a `docker compose` file.
- Official base image: `looped/agent` — mounts `agent.yaml`, reads secrets from env, persists memory to a volume.
- CLI (thin, comes after the core works):
  - `looped init` — scaffold an agent directory
  - `looped dev` — run locally with hot-reload of config
  - `looped run agent.yaml` — run for real (what the container entrypoint calls)

```
docker run -v ./agent.yaml:/agent/agent.yaml --env-file .env looped/agent
```

## Open questions

- Config: YAML canonical + `defineAgent()` later is the plan — how do the two interact (does YAML compile to the programmatic form internally)?
- MCP servers that are themselves containers: manage sibling containers, or require them as separate compose services?
- Memory backend beyond SQLite (Postgres for fleets?) — when does that matter?
- Streaming responses through triggers (progressive Discord edits?) or final-result-only for v1?
- Structured run traces: bespoke JSONL, or OpenTelemetry from day one?
