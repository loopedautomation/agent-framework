---
title: "CLI"
description: "Every af command: init, run, up, ps, down, validate, flags, schema, discord-invite."
---

`af` is the framework's CLI, published to JSR as [`@looped/af`](https://jsr.io/@looped/af). On macOS or Linux, install it with Homebrew — no Deno required:

```sh
brew install loopedautomation/tap/af
```

Or install from JSR with Deno:

```sh
deno install -g --allow-read --allow-write --allow-env --allow-net --allow-run=bash,docker,deno -n af jsr:@looped/af
```

Either way the CLI drives Docker, which must be installed and running. Upgrade a Homebrew install with `brew upgrade af`; a Deno install with `af update`.

The CLI orchestrates Docker under the hood: agents always execute in the published container, never on your machine. Pointing `af` at an agent file starts the container with the config mounted, the data volume attached and the env file passed. Config paths default to `./agent.yaml`.

```
af init [name]            Scaffold a new agent project (agent, secrets, deployment)
af run [agent.yaml]       Run one agent in Docker, interactive (REPL without triggers)
af up [agent.yaml...]     Start agents in Docker — foreground; -d to detach
af ps                     List af containers
af down [target...]       Stop and remove af containers (files or handles; none = all)
af validate [agent.yaml]  Validate an agent definition
af flags [agent.yaml]     Print the Deno sandbox flags this agent runs under
af schema                 Print the agent.yaml JSON Schema
af discord-invite <agent.yaml>
                          Print the bot's OAuth invite URL (no bitfield math)
af version                Print the af version (also --version, -v)
```

## Under the hood

Every `af` command that runs an agent expands to a plain `docker run` on the [published base image](docker-run.md) — no daemon of its own, no state outside Docker. `af up -d agent.yaml` is exactly this:

```sh
docker run -d --restart unless-stopped \
  --name af-agent \
  --label af.agent=agent \
  -v ./agent.yaml:/agent/agent.yaml:ro \
  --env-file .env \
  -v agent-data:/data \
  -p 127.0.0.1:0:9090 \
  --read-only --tmpfs /tmp \
  ghcr.io/loopedautomation/agent:0.6.0
```

That's the config and any `skills:` mounted read-only, the `<handle>-data` volume so identity survives restarts, the `.env` next to the agent file, the [status surface](docker-run.md#the-status-surface) on an ephemeral loopback port so fleets never collide, and a read-only root filesystem. The image tag matches the CLI's version — never `:latest`, so a cached image can't drift out from under a newer CLI (`--image` overrides). `af ps` and `af down` find containers by the `af.agent` label. Because it's all plain Docker, everything you know still works: `docker logs af-<handle>`, `docker stats`, restart policies, volume backups.

`--dry-run` on `run`/`up` prints the exact command for your agent instead of executing it — useful for pasting into a systemd unit or a runbook.

## af init

`af init` scaffolds a complete agent project into `<name>/`. It's interactive by default, and every question is also a flag, so you can script it as one line:

```sh
af init issue-helper --trigger discord --provider openai-compatible \
  --deploy compose --clis gh
```

| Flag | Choices | |
| --- | --- | --- |
| `--trigger` | `discord` `webhook` `cron` `none` | `none` = REPL agent |
| `--provider` | `openai-compatible` `anthropic` `codex` `local` | `codex` = ChatGPT subscription via `codex login`, no key; `local` = openai-compatible + Ollama `base_url`, no key |
| `--deploy` | `local` `docker` `compose` `compose-inline` `paas-git` `paas-env` | see below |
| `--model` | any model id | sensible default per provider |
| `--clis` | comma-separated executables | adds a Dockerfile layer + `permissions.run` |
| `--handle` / `[name]` | letters, digits, hyphens | what you call the agent |
| `--dir` | a directory | where to scaffold (default `.`) |

Every shape generates `agent.yaml`, `.env.example` (every secret the config references, ready to copy to `.env`) and a `README.md` with the exact deploy steps. Each deploy shape then adds its own files:

- **`local`** - nothing more; you `af validate` and `af run`.
- **`docker`** - the `docker run` command in the README, with the mounted config, env file and data volume.
- **`compose`** - a `compose.yaml`, a `Dockerfile` when `--clis` needs one and a `.gitignore`.
- **`compose-inline`** - a single `compose.yaml` with the agent config [defined inline](docker-compose.md#one-compose-file-the-whole-agent-inline) in a top-level `configs:` element and mounted at `/agent/agent.yaml`.
- **`paas-git`** - a `Dockerfile` and `compose.yaml` for platforms that build from a repo (Coolify, for example): you push, connect, set the env vars and deploy.
- **`paas-env`** - for platforms where a deploy is an image plus env vars: the stock image with the config in `AF_AGENT_CONFIG` and no files at all.

## af run

`af run` starts one agent in Docker, interactive and in the foreground (`docker run -it --rm`): a long-lived service if the config has `triggers:` and a REPL if it doesn't. On first boot the agent picks its name and prints the birth banner. Ctrl-c stops the container; the `<handle>-data` volume stays, so the identity survives.

Inside the published image the entrypoint calls the same command with `AF_CONTAINER=1` set, which makes `run` execute the agent in-process — that branch *is* the container entrypoint. Set `AF_CONTAINER=1` yourself only for framework development.

## af up

`af up` starts one container per agent file. The foreground default streams every agent's logs with a colored `[handle]` prefix and stops them all on ctrl-c; `-d` detaches with `--restart unless-stopped` and waits until each agent answers on its status port:

```
$ af up -d issue-bot/agent.yaml helpdesk/agent.yaml
✓ issue-bot  running · status http://127.0.0.1:55031
✓ helpdesk   running · status http://127.0.0.1:55047

af ps to inspect · af down to stop
```

For every agent it mounts the config and any `skills:` read-only, attaches the `<handle>-data` volume, passes the `.env` next to the agent file (`--env-file` overrides), publishes the [status surface](docker-run.md#the-status-surface) on an ephemeral loopback port and webhook trigger ports directly, and runs the container `--read-only`. `--image` overrides the image; `--dry-run` prints the docker command(s) and starts nothing. A handle that already has a container fails loudly — `af down` it first.

## af ps

`af ps` lists the af-managed containers (running or stopped, discovered by the `af.agent` label) with their state, uptime and status-surface address.

## af down

`af down` gracefully stops and removes af containers — pass agent files or handles, or nothing for all of them. Data volumes are never removed: a lost volume is a fresh identity.

## af validate

```
✓ agent.yaml is a valid agent definition
  handle:   issue-bot
  model:    openai-compatible / gpt-5.4-mini
  triggers: discord
  sandbox:  net open below the app layer; egress bounded by the container
  ⚠ permissions.run grants gh — a subprocess leaves the Deno sandbox
  env refs: OPENAI_API_KEY, DISCORD_BOT_TOKEN, GITHUB_TOKEN
  ⚠ not set in this environment: GITHUB_TOKEN
```

`af validate` parses the config (unknown keys are hard errors) and prints the identity, the triggers, every env var the config references (with a warning on any that aren't set in the environment) and which sandbox the agent gets.

This one granted `gh`, so it gets the container as its egress boundary. An agent that spawns nothing runs [hermetic](permission-model.md#hermetic-mode) instead, and `af validate` lists the hosts it's allowed to reach:

```
  sandbox:  hermetic — Deno enforces net for the whole process
  egress:   0.0.0.0:9090, api.anthropic.com, api.github.com
```

## af flags

`af flags` prints the Deno permission flags the agent runs under in the container, which is [layer 1 of the sandbox](permissions.md#the-layers).

An agent that spawns nothing runs [hermetic](permission-model.md#hermetic-mode): its net allowlist, plus the hosts the framework works out from the config, compiled into `--allow-net`.

```
$ af flags agent.yaml
--allow-env --allow-read=/agent,/skills,/data,/looped,/deno-dir,/run/secrets \
  --allow-write=/data --allow-net=0.0.0.0:9090,api.anthropic.com,api.github.com
```

If the agent has a `permissions.run` grant or a stdio MCP server, then a subprocess is going to leave the Deno sandbox and the runtime can't hold its network access. You get the image's flags instead, and the reason why on stderr.

## af schema

`af schema` prints the agent.yaml [JSON Schema](https://github.com/loopedautomation/agent-framework/blob/main/schema/agent.json). It's the same schema the runtime enforces and the one [editors validate against](agent-file.md#editor-support).

## af discord-invite

`af discord-invite` prints the bot's OAuth invite URL with the correct scopes and permissions (View Channels, Send Messages and Read Message History), so you don't have to do the bitfield math yourself. It needs the config, to find the Discord trigger's `token_env`, and that token set in the environment; it looks up the application id from the token. It's part of the [Discord setup](discord.mdx#setup).
