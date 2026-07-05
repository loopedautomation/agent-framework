---
title: "Docker run"
description: "Run an agent with a single docker run: the published base image, custom images, the status surface and the data volume."
---

One agent runs in one container, and the container is the unit of deployment, isolation and scaling. An agent behaves the same on a single machine as it does in a fleet. To run several agents together, see [Docker compose](docker-compose.md).

## Quick run

The [CLI](cli.md) starts the container for you — point it at the agent file:

```sh
af up -d agent.yaml    # detached; af ps to inspect, af down to stop
af up agent.yaml       # foreground, logs streaming, ctrl-c stops
af run agent.yaml      # interactive: REPL without triggers, service with
```

`af up` mounts the config and any skills read-only, attaches the `<handle>-data` volume, passes the `.env` sitting next to the agent file, publishes the status surface on an ephemeral loopback port, and runs the container read-only. `af up --dry-run` prints the exact command instead of running it.

## What it expands to

We publish the base image to GitHub Packages as **`ghcr.io/loopedautomation/agent`**. It's public, built for amd64 and arm64, and CI rebuilds it on every framework change. An agent is the YAML mounted onto that image — `af up -d` is this command:

```sh
docker run -d --restart unless-stopped \
  --name af-agent \
  -v ./agent.yaml:/agent/agent.yaml:ro \
  --env-file .env \
  -v agent-data:/data \
  -p 127.0.0.1:0:9090 \
  --read-only --tmpfs /tmp \
  ghcr.io/loopedautomation/agent:latest
```

If you'd rather build the image yourself, run `docker build -f images/agent/Dockerfile -t ghcr.io/loopedautomation/agent:latest .` from the repo root.

## File-less deploys: config via env var

Some platforms make environment variables easy and file mounts awkward. Coolify, Railway, Fly and any other platform where a deploy is an image plus env vars all have this shape. For these, you can put the YAML itself in `AF_AGENT_CONFIG` and deploy the stock image with no files at all; the agent reads its definition from the env var. If you set both the env var and a mounted `/agent/agent.yaml`, the agent refuses to start rather than guessing which one you meant.

Skills need real files, so this route only works for agents without them; bake a custom image if your agent has skills. We'd treat it as a last resort for platforms without file mounts. For compose deployments, keep configuration out of the environment and use the [single-file `configs:` shape](docker-compose.md#one-compose-file-the-whole-agent-inline) instead.

## The custom-image story

The Dockerfile defines the environment and the YAML defines the agent. If your agent needs a CLI the base image doesn't carry, add a layer:

```dockerfile
FROM ghcr.io/loopedautomation/agent:latest
USER root
RUN apk add --no-cache github-cli
USER looped

# Optional: bake the config and skills in so the image is self-contained
COPY --chown=looped:looped skills/gh-issues.md /skills/gh-issues.md
COPY --chown=looped:looped agent.yaml /agent/agent.yaml
```

[`examples/issue-bot`](https://github.com/loopedautomation/agent-framework/tree/main/examples/issue-bot) is the complete pattern, with the Dockerfile, the compose.yaml and an `.env.example`, deployed with [Docker compose](docker-compose.md).

## What the base image gives you

- **Hardened by default**: the process runs as `looped` (uid 10001), a non-root user, and the image contains bash for `run_bash` and nothing else. No browser, no extras. The compose examples add `read_only: true` and a tmpfs on top.
- **The Deno sandbox as layer 1**: reads are scoped to `/agent`, `/skills`, `/data` and `/run/secrets`, writes to `/data` only, and subprocess spawning is limited to bash, which the permission engine then gates per executable ([the layers](permissions.md#the-layers)).
- **Volumes**: `/data` holds the agent's SQLite database, with its sessions, runs, audit trail and chosen name. Persist this volume; a fresh volume gives the agent a fresh identity.
- **Health**: a `HEALTHCHECK` is wired to the status surface, so `docker ps` shows `healthy`.
- **Ports**: `8080` for the webhook trigger (if configured) and `9090` for the status surface.

## The status surface

Every service agent exposes:

- `GET /healthz` - liveness and identity (handle, chosen name, model, triggers, uptime). Unauthenticated.
- `GET /runs` and `GET /audit` - the run history and the permission decisions. Loopback-only unless `AF_STATUS_TOKEN` is set, and then they take bearer-token access.

```sh
curl -s localhost:9090/healthz | jq
```

`AF_STATUS_HOST` and `AF_STATUS_PORT` override the bind. The base image sets the host to `0.0.0.0`, so publish the port loopback-only, the way the compose examples do.

## Persistence: the data volume

Each agent owns one SQLite file: `/data/<handle>.db` in the container, or wherever `AF_DATA_DIR` points (locally it defaults to `.looped/`). It holds:

- **sessions/messages** - the conversation history per conversation key (when `memory.scope: thread`)
- **runs** - every run, with its trigger, input, status, steps, tokens and timestamps
- **audit** - every permission decision, allowed and denied
- **identity** - the name the agent chose on first boot

This means the agent's full history sits in one file you can query: everything the agent did, including the actions its permissions denied. Persist the volume; with a fresh one the agent starts over and names itself again.

## Secrets

`--env-file .env` is the simple path. The config references secrets as `${VAR}`, the env file supplies the values, and a missing reference fails at startup. Compose `secrets:` files resolve the same way; see [Docker compose](docker-compose.md#secrets). Secrets are injected into tools server side and never enter the model's context ([Permissions](permissions.md#secrets)).
