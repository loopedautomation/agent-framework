---
title: "Docker compose"
description: "Run one or many agents with Docker Compose: service blocks, fleets, inline config, and secrets."
---

Docker Compose is how you run one or many agents as a fleet. Each agent is one service block, with its image, volume, env file, and restart policy written down and versioned alongside the agent itself.

## One service block per agent

```yaml
services:
  issue-bot:
    image: ghcr.io/loopedautomation/agent:latest
    volumes:
      - ./agent.yaml:/agent/agent.yaml:ro
      - issue-bot-data:/data
    env_file: .env
    restart: unless-stopped
volumes:
  issue-bot-data:
```

`af init --deploy compose` generates this shape, plus a Dockerfile when the agent needs [extra CLIs in the image](docker-run.md#the-custom-image-story). The generated examples also add `read_only: true` and a tmpfs — hardening on top of what [the base image already gives you](docker-run.md#what-the-base-image-gives-you).

[`examples/issue-bot`](https://github.com/loopedautomation/agent-framework/tree/main/examples/issue-bot) is the complete pattern:

```sh
cd examples/issue-bot && cp .env.example .env  # fill in your keys
docker compose up -d
```

## One compose file: the whole agent, inline

A top-level `configs:` element collapses a compose deploy to a single file. The agent's config is defined inline and mounted into the container at `/agent/agent.yaml` — no separate file on disk, and no configuration passed through the environment:

```yaml
# compose.yaml — no agent.yaml anywhere
configs:
  agent-yaml:
    content: |
      handle: time-bot
      description: Answers questions, and knows what time it is.
      model:
        provider: openai-compatible
        id: gpt-5.4-mini
      purpose: |
        You are a concise assistant. Use current_time rather than guessing.

services:
  time-bot:
    image: ghcr.io/loopedautomation/agent:latest
    configs:
      - source: agent-yaml
        target: /agent/agent.yaml
    env_file: .env
    volumes:
      - time-bot-data:/data
    restart: unless-stopped
volumes:
  time-bot-data:
```

`af init --deploy compose-inline` generates this shape. Two things to know: inline `content:` requires Docker Compose v2.23.1 or newer, and env references *inside the embedded config* must be written `$${VAR}` (double dollar) so compose passes them through for the runtime to resolve, instead of substituting the value into the config at deploy time.

## Fleets

A fleet is the same file with more entries: each agent is one more service block with its own config, volume, and permissions. When a second job needs doing, run a second agent alongside the first rather than widening the first agent's scope.

## Secrets

Compose `secrets:` (mounted at `/run/secrets/<NAME>`) resolve identically to env vars — config references like `${GITHUB_TOKEN}` check the env first, then the secrets file. `env_file: .env` covers simple setups. Secrets never enter the model's context and are scoped per tool ([Permissions](permissions.md#secrets)).
