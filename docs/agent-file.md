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

By default the agent chooses its own display name. On first boot it names itself with a single LLM call (routed to the `model.small` role) and persists the name in its SQLite identity; the CLI prints a banner when this happens. You address the agent by its `handle`, and it signs its work with the name it chose. A fresh data volume means a fresh identity, and the agent will name itself again.

If you'd rather pick the name yourself, set the optional `name:` key (2–40 characters). The naming ritual is skipped entirely and the agent introduces itself with the name you gave it. Setting `name` also wins over a name the agent chose earlier, without erasing it — remove the key and the chosen name comes back.

## Purpose

`purpose` is the agent's job description and becomes its system prompt: what it does, how it behaves, and — just as important for event-driven agents — when to stay quiet. Be specific; this is the entire brief the model works from. A narrow, concrete purpose is what lets a small model be reliable.

`${VAR}` references in purpose resolve at startup the same way an `env:` block's do — process env first, then `/run/secrets/<VAR>`, failing on boot when missing. Use them for non-secret configuration that varies per deployment: a project id, a hostname, a repo name. The expanded text is the system prompt, fully visible to the model and not treated as a secret by the [redactor](secrets.md) — never reference a credential here; for authenticated APIs use [`http.auth`](secrets.md#credentials-for-http-attached-server-side) instead.

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
- **`small`** is the model for cheap internal calls (the naming ritual, [compaction](memory.md#compaction) summaries). Defaults to the main `id` — set it to something tiny and these calls round to free.
- **`fallbacks`** names model ids to try in order when the primary fails — validated today, with the runtime chain still landing ([Models](models.md#when-the-provider-fails)).

The full model story — dialects, keys, local endpoints, retries — is [Models](models.md).

## Memory

```yaml
memory:
  scope: thread             # default: none
  persistent: true          # default: false
  compact_at_tokens: 50000  # default: 50000; false disables
```

`none` (the default) starts every run fresh. `thread` persists conversation history per conversation key — the chat channel or thread (Discord, Slack, Telegram), the webhook caller's `conversation_id`, or the REPL session — so follow-ups work ("make it weekly instead"). `persistent: true` gives the agent `remember`/`recall`/`list_memories`/`forget` tools — facts that survive across conversation keys and container restarts, not just one thread's transcript. Both live in the agent's own SQLite file, nowhere else, and compose freely. `compact_at_tokens` keeps a long thread from growing without bound: once a conversation's context reaches the threshold, the older turns are folded into a model-written summary and the recent ones stay verbatim. The full story, including what the model sees in its system prompt and how it's audited, is in [Memory](memory.md).

## Limits

```yaml
limits:
  max_steps: 20        # default: 20 LLM calls per run
  max_cost: 5          # default: $5 of model spend per run; 0 disables
  max_runtime: 0       # default: off. Wall-clock seconds per run
  concurrent_runs: 4   # default: 4 conversations running at once
  queue_depth: 10      # default: 10 waiting events per conversation
```

`max_steps` caps how many LLM calls a run can make, so an unattended agent can only spend what you've allowed. The cap is on by default.

When a run hits the cap mid-task, the agent gets one final call with its tools removed and is asked to summarize what it has done, what remains unfinished and what should happen next. That summary becomes the run's reply, so a capped run hands you a progress report you can pick up from. If the wrap-up call fails or produces no text, the reply falls back to a plain "run ended after N steps" line. The wrap-up counts toward the recorded step count, which is why a capped run shows `max_steps + 1` calls.

`max_cost` is the same idea in dollars. Before each LLM call the run adds up what it has spent so far, and if that has reached the cap the run stops with `error_max_cost`. Checking before the call rather than after means the call that would take you over the line is the one that never happens. There is no wrap-up call here: spending another call to explain that you ran out of money is the wrong trade, so the status and the reply say what happened instead.

The default is $5 per run. That number is a runaway guard rather than a budget - `max_steps: 20` already bounds a normal run well below it - and it exists because an agent nobody is watching should not be able to spend without a ceiling. Set `max_cost: 0` to turn it off.

Costs come from a built-in price list covering the current Claude models. If your model isn't on that list, or you're behind a proxy or a negotiated rate, tell the agent what it costs:

```yaml
model:
  provider: openai-compatible
  id: my-hosted-model
  pricing:
    input_per_mtok: 0.60
    output_per_mtok: 2.40
```

Without a price the runtime can't compute spend, so `max_cost` can't be enforced. It says so on startup and names the model, rather than leaving a cap in your agent file that quietly does nothing. Run costs are recorded per run and totalled in `/status`, where an unpriced run is left out of the total rather than counted as free.

`max_runtime` caps wall-clock seconds per run, checked at step boundaries. It's off by default: a slow run costs nothing extra, and legitimate work can be slow. Turn it on when a run holding a lane matters more than the run finishing - a cron schedule that must not overlap the next firing, say. A single long tool call can overshoot the limit, because the check happens between steps rather than interrupting work in flight.

`concurrent_runs` and `queue_depth` decide what happens when events arrive faster than the agent finishes them. Within one conversation, runs are serial and ordered: a message that arrives mid-run waits its turn, and each run loads the history its predecessor saved, so message four's run sees what messages one through three did. Across conversations the agent runs in parallel, up to `concurrent_runs` at a time, so one person's long task doesn't make the agent look dead to everyone else. Setting `concurrent_runs: 1` serializes the whole agent.

A conversation's queue holds `queue_depth` events. Past that, the event is refused on the spot: the sender gets a short built-in reply through the normal channel (webhook callers get a 429), and the refusal lands in the audit trail. The queue lives in memory, which means a container restart drops whatever was waiting; the runs table records every run that started, so you can tell what was lost.

Cron gets one extra promise: a schedule never overlaps itself. At most one firing runs and one waits, and further firings while both slots are full are skipped, with an audit entry each. The details are on the [Cron page](cron.mdx).

Every result carries a typed status:

| Status | Meaning |
| --- | --- |
| `ok` | The agent finished its job. |
| `error_max_steps` | The run hit `limits.max_steps`; the reply carries the agent's wrap-up summary. |
| `error_provider` | The provider failed after retries. |
| `rejected` | The event was refused because its queue was full; no run started, and the refusal is recorded in the audit trail. |

Each run's status, step count and token usage are recorded in [the data volume](docker-run.md#persistence-the-data-volume).

## Env

```yaml
env:
  GITHUB_TOKEN: ${GITHUB_TOKEN}   # secret: scoped, and redacted on the way out
public:
  POSTHOG_PROJECT_ID: 12345       # configuration: scoped, and left visible
```

The `env:` block grants environment variables to tools and MCP servers — and only those; subprocesses never inherit the agent process's ambient environment. Values may be `${VAR}` references, resolved at startup from the process env, then from `/run/secrets/<VAR>` (Docker Compose file secrets). A missing reference fails at startup, before any event is handled. The value is scoped to the tools that need it, and any tool output quoting it back is scrubbed.

Everything in `env:` is treated as a secret, which is wrong for configuration the agent has to read back — a project id redacted out of the URLs it builds looks like an agent that can't see its own settings. `public:` is the same block without the redaction, and it takes bare numbers without quoting. The full story, and when not to reach for it, is in [Secrets](secrets.md#configuration-the-agent-has-to-read-public).

## The blocks with their own pages

- **`triggers:`** — the events that wake the agent. With triggers, `af run` starts a long-lived service; without, an interactive REPL. → [Discord](discord.mdx) · [Slack](slack.mdx) · [Telegram](telegram.mdx) · [Email](email.mdx) · [Webhook & GitHub](webhook.mdx) · [TTY](tty.mdx) · [Cron](cron.mdx)
- **`skills:`** — markdown files that teach the agent how to use something well; capability stays with the config. → [Skills](skills.md)
- **`tools:`** — capability beyond the natives: MCP servers, and tool search to keep their schemas out of context. → [Tools](tools.md)
- **`permissions:`** — deny-by-default allowlists for hosts, executables, and paths. Omit the block and the agent can touch nothing. → [Permissions](permissions.md)
- **`http:`** - credentials the runtime attaches to outbound `http_request` calls, so an authenticated API needs no key in a model-visible header. → [Secrets](secrets.md)
- **`redact:`** - extra secret values and header names to scrub, on top of the ones the config already names. → [Secrets](secrets.md)
- **`memory:`** — conversation history (`scope`), facts that survive across conversations and restarts (`persistent`), and auto-compaction (`compact_at_tokens`). → [Memory](memory.md)
- **`schedules:`** — the agent files future work for itself: reminders and recurring runs it creates in conversation. → [Scheduling](scheduling.md)
- **`commands:`** — operator-defined slash commands, alongside the built-ins `/help`, `/status`, `/reset`, `/compact` and `/new`. → [Slash commands](slash-commands.md)

## Validating

`af validate agent.yaml` parses the file, prints the identity, triggers, compiled sandbox flags, and every env var referenced — warning on any that aren't set.

### Editor support

Add this as the first line of any agent file and your editor (VS Code, JetBrains, Neovim — anything running yaml-language-server) validates as you type: autocomplete on every key, hover docs from the field descriptions, red squiggles on typos:

```yaml
# yaml-language-server: $schema=https://looped.sh/schema/agent.json
```

The schema is generated from the same source of truth the runtime enforces ([schema/agent.json](https://github.com/loopedautomation/agent-framework/blob/main/schema/agent.json), kept current by CI), so nothing can exist in the gap between "accepted" and "documented". `af schema` prints it locally.
