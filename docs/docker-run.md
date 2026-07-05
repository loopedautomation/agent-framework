---
title: "Docker run"
description: "Run an agent in a container with one command: the published base image, custom images, the status surface and the data volume."
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

## The base image

We publish the base image to GitHub Packages as **`ghcr.io/loopedautomation/agent`**. It's public, built for amd64 and arm64, and rebuilt on every release: each version gets its own immutable tag, and `:latest` always points at the newest release. An agent is the YAML mounted onto that image, and every `af` command expands to a plain `docker run` against it — the [CLI page shows the exact expansion](cli.md#under-the-hood), and `af up --dry-run agent.yaml` prints it for your agent, ready for a systemd unit or a runbook.

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

Build it and point the CLI at it:

```sh
docker build -t my-agent .
af up -d --image my-agent agent.yaml
```

[`examples/gh-issues-cli`](https://github.com/loopedautomation/agent-framework/tree/main/examples/gh-issues-cli) is the complete pattern, with the Dockerfile, the compose.yaml and an `.env.example`, deployed with [Docker compose](docker-compose.md).

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

`af ps` shows each agent's status address — `af up` publishes port 9090 on an ephemeral loopback port so agents never collide:

```sh
af ps                                # HANDLE · STATE · STATUS · STATUS ADDR
curl -s 127.0.0.1:55031/healthz | jq   # the addr af ps printed
```

`AF_STATUS_HOST` and `AF_STATUS_PORT` override the bind. The base image sets the host to `0.0.0.0`, so publish the port loopback-only, the way `af up` and the compose examples do.

## Persistence: the data volume

Each agent owns one SQLite file: `/data/<handle>.db` in the container, or wherever `AF_DATA_DIR` points (locally it defaults to `.looped/`). It holds:

- **sessions/messages** - the conversation history per conversation key (when `memory.scope: thread`)
- **runs** - every run, with its trigger, input, status, steps, tokens and timestamps
- **audit** - every permission decision, allowed and denied
- **identity** - the name the agent chose on first boot

This means the agent's full history sits in one file you can query: everything the agent did, including the actions its permissions denied. Persist the volume; with a fresh one the agent starts over and names itself again.

## Secrets

A `.env` file next to the agent file is the simple path — `af up` passes it automatically (`--env-file` points elsewhere), and warns about any `${VAR}` the config references that the file doesn't supply. A missing reference fails at startup. Compose `secrets:` files resolve the same way; see [Docker compose](docker-compose.md#secrets). Secrets are injected into tools server side and never enter the model's context ([Permissions](permissions.md#secrets)).
