---
title: "Agent config"
description: "A guided tour of every block in agent.yaml — identity, model, memory, limits, and env."
---

Each agent is defined by a single file. The agent file describes everything about an agent: its identity, the model that runs it, the events that wake it, and the boundaries it operates within. This page walks through every block; the exhaustive field list lives in the [JSON Schema](https://github.com/loopedautomation/agent-framework/blob/main/schema/agent.json), which your editor can enforce as you type ([set it up](#editor-support)) and `af schema` prints locally.

Here is a complete agent, for orientation:

```yaml
# yaml-language-server: $schema=https://looped.sh/schema/agent.json
handle: issue-bot
description: Turns team Discord messages into GitHub issues.

model:
  provider: openai-compatible
  id: gpt-5.4-mini

purpose: |
  You turn Discord messages into well-formed GitHub issues in myorg/myrepo,
  using the gh CLI. Reply with the issue link. If a message isn't an issue
  report or feature request, say so briefly instead of inventing one.

triggers:
  - type: discord
    channels: ["issues"]

skills:
  - ./skills/gh-issues.md

permissions:
  net: [api.github.com]
  run: [gh]

env:
  GITHUB_TOKEN: ${GITHUB_TOKEN}

memory:
  scope: thread

limits:
  max_steps: 15
```

Four keys are required: `handle`, `description`, `model`, and `purpose`. Everything else is optional, and unknown keys are validation errors — a misspelled `permisions:` fails immediately rather than being silently ignored.

## Identity: handle, description — and the name

`handle` is what *you* call the agent — letters, digits, hyphens (`^[a-zA-Z0-9][a-zA-Z0-9-]*$`). It names the compose service, the log lines, and the agent's database file. `description` is one line: what job this agent does.

You don't choose the agent's display name. On first boot the agent names itself with a single LLM call (routed to the `model.small` role) and persists the name in its SQLite identity; the CLI prints a banner when this happens. You address the agent by its `handle`, and it signs its work with the name it chose. A fresh data volume means a fresh identity, and the agent will name itself again.

## Purpose

`purpose` is the agent's job description and becomes its system prompt: what it does, how it behaves, and — just as important for event-driven agents — when to stay quiet. Be specific; this is the entire brief the model works from. A narrow, concrete purpose is what lets a small model be reliable.

## Model

```yaml
model:
  provider: openai-compatible   # or: anthropic, codex
  id: gpt-5.4-mini
  # base_url: http://localhost:11434/v1   # any compatible endpoint, e.g. Ollama
  # api_key_env: OPENAI_API_KEY           # names the env var; the key stays out of config
  # small: gpt-5.4-nano                   # for cheap internal calls
  # fallbacks: [gpt-5.4]                  # tried in order when the primary fails
```

- **`provider`** is a dialect: `openai-compatible` covers OpenAI, Ollama, vLLM, and anything speaking that API; `anthropic` is the native Anthropic API; `codex` runs on an OpenAI Codex (ChatGPT) subscription via the credentials from `codex login`, with no API key involved. Swapping providers is one config line — no provider is load-bearing.
- **`base_url`** points `openai-compatible` at any endpoint. Local models need no key.
- **`api_key_env`** names the env var holding the key; the key itself stays out of the config. Defaults to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` per provider.
- **`small`** is the model for cheap internal calls (the naming ritual, summaries). Defaults to the main `id` — set it to something tiny and these calls round to free.
- **`fallbacks`** names model ids to try in order when the primary fails — validated today, with the runtime chain still landing ([Models](models.md#when-the-provider-fails)).

The full model story — dialects, keys, local endpoints, retries — is [Models](models.md).

## Memory

```yaml
memory:
  scope: thread       # default: none
  persistent: true    # default: false
```

`none` (the default) starts every run fresh. `thread` persists conversation history per conversation key — the chat channel or thread (Discord, Slack, Telegram), the webhook caller's `conversation_id`, or the REPL session — so follow-ups work ("make it weekly instead"). `persistent: true` gives the agent `remember`/`recall`/`list_memories`/`forget` tools — facts that survive across conversation keys and container restarts, not just one thread's transcript. Both live in the agent's own SQLite file, nowhere else, and compose freely. The full story, including what the model sees in its system prompt and how it's audited, is in [Memory](memory.md).

## Limits

```yaml
limits:
  max_steps: 20     # default: 20 LLM calls per run
```

`max_steps` caps how many LLM calls a run can make, so an unattended agent can only spend what you've allowed. The cap is on by default.

When a run hits the cap mid-task, the agent gets one final call with its tools removed and is asked to summarize what it has done, what remains unfinished and what should happen next. That summary becomes the run's reply, so a capped run hands you a progress report you can pick up from. If the wrap-up call fails or produces no text, the reply falls back to a plain "run ended after N steps" line. The wrap-up counts toward the recorded step count, which is why a capped run shows `max_steps + 1` calls.

Every run ends with a typed status:

| Status | Meaning |
| --- | --- |
| `ok` | The agent finished its job. |
| `error_max_steps` | The run hit `limits.max_steps`; the reply carries the agent's wrap-up summary. |
| `error_provider` | The provider failed after retries. |

Each run's status, step count and token usage are recorded in [the data volume](docker-run.md#persistence-the-data-volume).

## Env

```yaml
env:
  GITHUB_TOKEN: ${GITHUB_TOKEN}
```

The `env:` block grants environment variables to tools and MCP servers — and only those; subprocesses never inherit the agent process's ambient environment. Values may be `${VAR}` references, resolved at startup from the process env, then from `/run/secrets/<VAR>` (Docker Compose file secrets). A missing reference fails at startup, before any event is handled. Secrets never enter the model's context — the full story is in [Permissions](permissions.md#secrets).

## The blocks with their own pages

- **`triggers:`** — the events that wake the agent. With triggers, `af run` starts a long-lived service; without, an interactive REPL. → [Discord](discord.mdx) · [Slack](slack.mdx) · [Telegram](telegram.mdx) · [Email](email.mdx) · [Webhook](webhook.mdx) · [Cron](cron.mdx)
- **`skills:`** — markdown files that teach the agent how to use something well; capability stays with the config. → [Skills](skills.md)
- **`tools:`** — capability beyond the natives: MCP servers, and tool search to keep their schemas out of context. → [Tools](tools.md)
- **`permissions:`** — deny-by-default allowlists for hosts, executables, and paths. Omit the block and the agent can touch nothing. → [Permissions](permissions.md)
- **`memory:`** — conversation history (`scope`) and facts that survive across conversations and restarts (`persistent`). → [Memory](memory.md)

## Validating

`af validate agent.yaml` parses the file, prints the identity, triggers, compiled sandbox flags, and every env var referenced — warning on any that aren't set.

### Editor support

Add this as the first line of any agent file and your editor (VS Code, JetBrains, Neovim — anything running yaml-language-server) validates as you type: autocomplete on every key, hover docs from the field descriptions, red squiggles on typos:

```yaml
# yaml-language-server: $schema=https://looped.sh/schema/agent.json
```

The schema is generated from the same source of truth the runtime enforces ([schema/agent.json](https://github.com/loopedautomation/agent-framework/blob/main/schema/agent.json), kept current by CI), so nothing can exist in the gap between "accepted" and "documented". `af schema` prints it locally.
