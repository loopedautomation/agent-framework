---
title: "Docker run"
description: "Run an agent with a single docker run: the published base image, custom images, the status surface, and the data volume."
---

The container is the unit of deployment, isolation, and scaling, and each container runs exactly one agent. An agent runs the same on a single machine as it does in a fleet. This page covers the published image, running an agent with a single `docker run`, and what every deployed agent provides. To run several agents together, see [Docker compose](docker-compose.md).

## Quick run

The base image is published to GitHub Packages as **`ghcr.io/loopedautomation/agent`** (public, multi-arch: amd64 + arm64, rebuilt by CI on every framework change). Run any agent by mounting its YAML:

```sh
docker run -d \
  -v ./agent.yaml:/agent/agent.yaml:ro \
  --env-file .env \
  -v agent-data:/data \
  ghcr.io/loopedautomation/agent:latest
```

To build the image locally instead, run `docker build -f images/agent/Dockerfile -t ghcr.io/loopedautomation/agent:latest .` from the repo root.

## File-less deploys: config via env var

Some platforms make environment variables easy but file mounts awkward — Coolify, Railway, Fly, and any other "image plus env vars" deployment form. For these, put the YAML itself in `LOOPED_AGENT_CONFIG` and deploy the stock image with no files at all. The agent reads its definition from the env var; setting both the env var and a mounted `/agent/agent.yaml` is a startup error (never a guess). Skills need real files, so this route suits skill-less agents — bake a custom image otherwise. Treat this as a last resort for platforms without file mounts; compose deployments should keep configuration out of the environment and use the [single-file `configs:` shape](docker-compose.md#one-compose-file-the-whole-agent-inline) instead.

## The custom-image story

The Dockerfile defines the environment; the YAML defines the agent. If the agent needs a CLI the base image doesn't carry, add a layer:

```dockerfile
FROM ghcr.io/loopedautomation/agent:latest
USER root
RUN apk add --no-cache github-cli
USER looped

# Optional: bake config + skills in for a self-contained, ship-anywhere artifact
COPY --chown=looped:looped skills/gh-issues.md /skills/gh-issues.md
COPY --chown=looped:looped agent.yaml /agent/agent.yaml
```

[`examples/issue-bot`](https://github.com/loopedautomation/agent-framework/tree/main/examples/issue-bot) is the complete pattern — Dockerfile + compose.yaml + `.env.example` — deployed with [Docker compose](docker-compose.md).

## What the base image gives you

- **Hardened by default**: non-root user (`looped`, uid 10001), bash for `run_bash`, nothing else — no browser, no extras. The compose example adds `read_only: true` + tmpfs.
- **Deno sandbox as layer 1**: reads scoped to `/agent`, `/skills`, `/data`, `/run/secrets`; writes to `/data` only; subprocess spawning limited to bash (which the permission engine then gates per-executable — [the layers](permissions.md#the-layers)).
- **Volumes**: `/data` holds the agent's SQLite (sessions, runs, audit, its chosen name). Persist this volume — a fresh volume gives the agent a fresh identity.
- **Health**: `HEALTHCHECK` wired to the status surface; `docker ps` shows `healthy`.
- **Ports**: `8080` webhook trigger (if configured), `9090` status surface.

## The status surface

Every service agent exposes:

- `GET /healthz` — liveness + identity (handle, chosen name, model, triggers, uptime). Unauthenticated.
- `GET /runs`, `GET /audit` — run history and permission decisions. Loopback-only unless `LOOPED_STATUS_TOKEN` is set, then bearer-token access.

```sh
curl -s localhost:9090/healthz | jq
```

`LOOPED_STATUS_HOST` and `LOOPED_STATUS_PORT` override the bind (the base image sets host `0.0.0.0`; publish the port loopback-only, as the compose examples do).

## Persistence: the data volume

Each agent owns one SQLite file — `/data/<handle>.db` in the container (`LOOPED_DATA_DIR` elsewhere; default `.looped/` locally) — holding:

- **sessions/messages** — conversation history per conversation key (when `memory.scope: thread`)
- **runs** — every run: trigger, input, status, steps, tokens, cost, timestamps
- **audit** — every permission decision, allowed and denied
- **identity** — the name the agent chose on first boot

This gives you the agent's full accountability record in one file you can query: what the agent did, what it cost, and what it attempted that was denied. Persist the volume — with a fresh volume the agent starts over and names itself again.

## Secrets

`--env-file .env` is the simple path: the config references secrets as `${VAR}`, the env file supplies the values, and a missing reference fails at startup. Compose `secrets:` files resolve identically — see [Docker compose](docker-compose.md#secrets). Secrets never enter the model's context and are scoped per tool ([Permissions](permissions.md#secrets)).
