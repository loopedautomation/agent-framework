---
title: "Getting started"
description: "Zero to a running agent: scaffold a project, define it in YAML, validate it, run it."
---

This walkthrough takes you from nothing to a running agent. The rest of the framework has its own pages: every config block in [The agent file](agent-file.md), events in [Triggers](triggers.md), capability in [Skills](skills.md) and [Tools](tools.md), boundaries in [Permissions](permissions.md), shipping in [Deployment](deployment.md).

## Prerequisites

- [Deno](https://deno.com) 2.x and a checkout of [the repo](https://github.com/loopedautomation/agent-framework) — `af` below means `deno task af` from the repo root, until the CLI ships standalone
- An API key for an OpenAI-compatible endpoint (or Anthropic) — or a local model, no key required

## 1. Scaffold an agent

```sh
deno task af init time-bot
```

`af init` asks three questions — trigger, provider, deployment shape (plus which CLIs the agent needs) — and generates a complete project: the agent file, a `.env.example` naming every secret it references, a README with the exact deploy steps, and a Dockerfile or compose file when the shape calls for one. Every question is also a flag, so the whole thing scripts as one line ([CLI reference](cli.md#af-init)).

Or skip the generator and write the file by hand — it's one file, and that's the point.

## 2. The agent file

One agent, one job, one file:

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

purpose: |
  You are a concise assistant. When asked about the current date or time,
  use the current_time tool rather than guessing.
```

Notes:

- **You don't name the agent** — `nickname` is your operator handle; the agent chooses its own name on first boot (the naming ritual — watch for the banner).
- Unknown keys are **hard errors**. A typo'd `permisions:` must never silently no-op.
- `api_key_env` defaults to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` per provider. Configs hold env *references*, never secret values.
- Any OpenAI-compatible endpoint works: set `model.base_url` (e.g. `http://localhost:11434/v1` for Ollama — no key required).

Every block, explained: [The agent file](agent-file.md).

## 3. Validate it

```sh
deno task af validate agent.yaml
```

Prints the parsed identity, trigger summary, compiled sandbox flags, and every env var the config references — with a warning for any that aren't set.

## 4. Run it

```sh
export OPENAI_API_KEY=sk-...
deno task af run agent.yaml
```

```
Meridian (time-bot) is listening (model: gpt-5.4-mini; ctrl-d to exit)
you> what time is it?

Meridian> It's 21:14 UTC on July 3, 2026.

[ok · 2 steps · 743in/41out tokens · $0.000136]
```

Without triggers, `af run` is an interactive REPL — the fastest way to iterate on a `purpose`. Add `triggers:` to the config and the same command starts a long-lived service instead ([Triggers](triggers.md)).

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

Add this as the first line of any agent.yaml and your editor (VS Code, JetBrains, Neovim — anything running yaml-language-server) validates as you type: autocomplete on every key, hover docs from the field descriptions, red squiggles on typos:

```yaml
# yaml-language-server: $schema=https://looped.sh/schema/agent.json
```

The schema is generated from the same source of truth the runtime enforces ([schema/agent.json](https://github.com/loopedautomation/agent-framework/blob/main/schema/agent.json), kept current by CI), so nothing can exist in the gap between "accepted" and "documented". `af schema` prints it locally.

## What's next

- Walk through every config block: [The agent file](agent-file.md)
- Give the agent triggers (Discord, webhook, cron) and run it as a long-lived service: [Triggers](triggers.md)
- Teach it skills and wire up tools: [Skills](skills.md) · [Tools](tools.md)
- Package it and ship it: [Deployment](deployment.md)
- Or start from a complete, runnable agent: the [issue-bot example](https://github.com/loopedautomation/agent-framework/tree/main/examples/issue-bot) — the same file shape, plus triggers, skills, and permissions, deployed with `docker compose up`
