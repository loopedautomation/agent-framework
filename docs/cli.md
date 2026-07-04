---
title: "CLI"
description: "Every af command: init, run, validate, flags, schema, discord-invite."
---

`af` is the framework's CLI. Until it ships standalone, run it from a repo checkout as `deno task af`. Config paths default to `./agent.yaml`, and everywhere a file is expected, `LOOPED_AGENT_CONFIG` (the YAML itself in an env var) replaces it for [file-less deploys](deployment.md#file-less-deploys-config-via-env-var).

```
af init [name]            Scaffold a new agent project (agent, secrets, deployment)
af run [agent.yaml]       Run an agent (service mode with triggers, REPL without)
af validate [agent.yaml]  Validate an agent definition
af flags [agent.yaml]     Print compiled Deno permission flags
af schema                 Print the agent.yaml JSON Schema
af discord-invite <agent.yaml>
                          Print the bot's OAuth invite URL (no bitfield math)
```

## af init

Scaffolds a complete agent project into `<name>/`. Interactive by default; every question is also a flag, so it scripts as one line:

```sh
af init issue-helper --trigger discord --provider openai-compatible \
  --deploy compose --clis gh
```

| Flag | Choices | |
| --- | --- | --- |
| `--trigger` | `discord` `webhook` `cron` `none` | `none` = REPL agent |
| `--provider` | `openai-compatible` `anthropic` `local` | `local` = openai-compatible + Ollama `base_url`, no key |
| `--deploy` | `local` `docker` `compose` `compose-inline` `paas-git` `paas-env` | see below |
| `--model` | any model id | sensible default per provider |
| `--clis` | comma-separated executables | adds a Dockerfile layer + `permissions.run` |
| `--nickname` / `[name]` | lowercase, hyphens | your handle for the agent |
| `--dir` | a directory | where to scaffold (default `.`) |

Every shape generates `agent.yaml`, `.env.example` (every secret the config references, ready to copy to `.env`), and a `README.md` with the exact deploy steps. The deploy shapes add:

- **`local`** — nothing more: `af validate`, `af run`.
- **`docker`** — the `docker run` incantation in the README (mounted config, env file, data volume).
- **`compose`** — `compose.yaml` (+ `Dockerfile` when `--clis` needs one), `.gitignore`.
- **`compose-inline`** — a single `compose.yaml` with the whole agent config embedded in `LOOPED_AGENT_CONFIG` — [one file, no agent.yaml](deployment.md#one-compose-file-the-whole-agent-inline).
- **`paas-git`** — `Dockerfile` + `compose.yaml` for platforms that build from a repo (e.g. Coolify): push, connect, set env vars, deploy.
- **`paas-env`** — for "image + env vars" platforms: deploy the stock image with the config in `LOOPED_AGENT_CONFIG`, no files at all.

## af run

Runs the agent: a long-lived service if the config has `triggers:`, an interactive REPL otherwise. First boot performs the naming ritual and prints the birth banner. Service mode starts the triggers and the [status surface](deployment.md#the-status-surface), and shuts down cleanly on SIGINT/SIGTERM.

## af validate

```
✓ agent.yaml is a valid agent definition
  nickname: issue-bot
  model:    openai-compatible / gpt-5.4-mini
  triggers: discord
  sandbox:  --allow-net=api.github.com --allow-run=gh
  env refs: OPENAI_API_KEY, DISCORD_BOT_TOKEN, GITHUB_TOKEN
  ⚠ not set in this environment: GITHUB_TOKEN
```

Parses the config (unknown keys are hard errors), prints the identity, triggers, compiled sandbox flags, and every env var referenced — warning on any that aren't set.

## af flags

Prints the Deno permission flags the config's `permissions:` block compiles to — [layer 1 of the sandbox](permissions.md#the-layers):

```
--allow-net=api.github.com --allow-run=gh
```

## af schema

Prints the agent.yaml [JSON Schema](https://github.com/loopedautomation/agent-framework/blob/main/schema/agent.json) — the same one the runtime enforces and [editors validate against](getting-started.md#editor-support).

## af discord-invite

Prints the bot's OAuth invite URL with the correct scopes and permissions (View Channels, Send Messages, Read Message History) — no bitfield math. Needs the config (to find the Discord trigger's `token_env`) and that token set in the environment; it looks up the application id from the token. Part of the [Discord setup ritual](triggers.md#discord).
