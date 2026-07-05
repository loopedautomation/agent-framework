---
title: "Quick start"
description: "From an empty directory to a running agent in about five minutes."
---

This guide takes you from an empty directory to a running agent in about five minutes: you write one file, validate it, and run it. Everything runs through Docker, so there is nothing else to install.

## 0. Prerequisites

- [Docker](https://docs.docker.com/get-started/get-docker/) — agents run from the published base image, [`ghcr.io/loopedautomation/agent`](https://github.com/loopedautomation/agent-framework/pkgs/container/agent)
- An API key for an OpenAI-compatible or Anthropic endpoint — or a local model via Ollama, no key required

## 1. Write the agent file

An agent is defined entirely by a single file. Create a project directory, then add the definition as `agent.yaml`:

```sh
mkdir time-bot && cd time-bot
```

```yaml
# agent.yaml
handle: time-bot
description: Answers questions, and knows what time it is.

model:
  provider: openai-compatible   # or: anthropic
  id: gpt-5.4-mini

purpose: |
  You are a concise assistant. When asked about the current date or time,
  use the current_time tool rather than guessing.
```

- The `handle` is the identifier you use to refer to the agent. The agent chooses its own display name on first boot and announces it in a startup banner.
- Unknown keys are validation errors, so a misspelled key such as `permisions:` fails immediately instead of being silently ignored.
- To use a local model instead, add `base_url: http://host.docker.internal:11434/v1` under `model:` — no API key is needed. (`localhost` would resolve to the container itself; on Linux, also add `--add-host=host.docker.internal:host-gateway` to the commands below.)

Every block is explained in [Agent Config](agent-file.md).

## 2. Validate it

```sh
docker run --rm -v ./agent.yaml:/agent/agent.yaml:ro \
  ghcr.io/loopedautomation/agent:latest validate /agent/agent.yaml
```

Prints the parsed identity, compiled sandbox flags, and every env var the config references — with a warning for any that aren't set.

## 3. Run it

```sh
export OPENAI_API_KEY=sk-...
docker run --rm -it \
  -v ./agent.yaml:/agent/agent.yaml:ro \
  -e OPENAI_API_KEY \
  -v time-bot-data:/data \
  ghcr.io/loopedautomation/agent:latest
```

```
Meridian (time-bot) is listening (model: gpt-5.4-mini; ctrl-d to exit)
you> what time is it?

Meridian> It's 21:14 UTC on July 3, 2026.

[ok · 2 steps · 743in/41out tokens · $0.000136]
```

Your first agent is now running locally. The image's default command runs the mounted config, and the `/data` volume holds the agent's memory and identity — persist it and the agent keeps the name it chose. Every run reports its status, step count and token usage.

## What's next

Without `triggers:`, running the agent starts an interactive REPL, which is the fastest way to iterate on a `purpose`. From here you can:

- Give it triggers and the same image runs a long-lived service: [Discord](discord.mdx) · [Webhook](webhook.mdx) · [Cron](cron.mdx)
- Teach it skills and wire up tools: [Skills](skills.md) · [Tools](tools.md)
- Grant it capability safely: [Permissions](permissions.md)
- Ship it for real — the base image, fleets, PaaS: [Docker run](docker-run.md) · [Docker compose](docker-compose.md)
- Generate a complete project instead of writing the files by hand — `af init` scaffolds the agent, secrets, and deployment shape: [CLI](cli.md#af-init)
- Start from a complete, runnable agent: the [issue-bot example](https://github.com/loopedautomation/agent-framework/tree/main/examples/issue-bot) uses the same file shape, adds triggers, skills, and permissions, and deploys with `docker compose up`
