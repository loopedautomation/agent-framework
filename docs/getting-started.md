# Getting started

Status: pre-release — this walkthrough tracks `main` and covers the core: defining an agent in YAML and running it interactively from the CLI. The rest has shipped and has its own pages: triggers and permissions in [Service agents](service-agents.md), skills and MCP in [Skills & tools](skills-and-tools.md), Docker packaging in [Deployment](deployment.md) ([roadmap](../plans/003-roadmap.md)).

## Prerequisites

- [Deno](https://deno.com) 2.x
- An API key for an OpenAI-compatible endpoint (or Anthropic)

## 1. Define an agent

One agent, one job, one YAML file:

```yaml
# agent.yaml
nickname: time-bot
description: Answers questions, and knows what time it is.

model:
  provider: openai-compatible   # or: anthropic
  id: gpt-5.4-mini
  pricing:                      # your model's real prices (enforces limits.max_cost)
    input_per_mtok: 0.15
    output_per_mtok: 0.60

system_prompt: |
  You are a concise assistant. When asked about the current date or time,
  use the current_time tool rather than guessing.
```

Notes:

- **You don't name the agent** — `nickname` is your operator handle; the agent chooses its own name on first boot (the naming ritual — watch for the banner).
- Unknown keys are **hard errors**. A typo'd `permisions:` must never silently no-op.
- `api_key_env` defaults to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` per provider. Configs hold env *references*, never secret values.
- Any OpenAI-compatible endpoint works: set `model.base_url` (e.g. `http://localhost:11434/v1` for Ollama — no key required).

## 2. Validate it

```sh
deno task af validate agent.yaml
```

Prints the parsed identity, trigger summary, and every env var the config references — with a warning for any that aren't set.

## 3. Run it

```sh
export OPENAI_API_KEY=sk-...
deno task af run agent.yaml
```

```
time-bot is listening (model: gpt-5.4-mini; ctrl-d to exit)
you> what time is it?

time-bot> It's 21:14 UTC on July 3, 2026.

[ok · 2 steps · 743in/41out tokens · $0.000136]
```

Every run reports its status, step count, tokens, and cost — cheap models are the default, and the numbers should stay boring.

## Budgets

Every run is budgeted by default — you configure the caps only when the defaults don't fit:

```yaml
limits:
  max_steps: 20     # default: 20 inner-loop iterations
  max_cost: 0.05    # no default; requires model.pricing to enforce
```

These are dead-man's switches: a run that exceeds them ends with a typed status (`error_max_steps`, `error_max_cost`) instead of running away. `max_cost` requires `model.pricing` — a cap can't be enforced without prices.

## Editor support

Generate the JSON Schema for `agent.yaml` autocompletion:

```sh
deno task af schema > agent-schema.json
```

## What's next

- Give the agent triggers (Discord, webhook, cron) and run it as a long-lived service: [Service agents](service-agents.md)
- Teach it skills and wire up MCP servers: [Skills & tools](skills-and-tools.md)
- Package it and ship it: [Deployment](deployment.md)
- Or start from a complete, runnable agent: the [issue-bot example](../examples/issue-bot/) — the same file shape, plus triggers, skills, and permissions, deployed with `docker compose up`

The [plans](../plans/) are the source of truth.
