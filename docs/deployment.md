---
title: "Deployment"
description: "The container is the computer: the base image, custom images, compose fleets, and the status surface."
---

The container is the unit of deployment, isolation, and scaling. One agent per container; a fleet is a compose file. It runs the same on a Mac mini as it does in a fleet — if it doesn't run cleanly in a container, it doesn't ship.

`af init` generates the deployment shape along with the agent — local, plain `docker run`, compose, a single self-contained compose file, or the two PaaS shapes — each with a README of exact steps ([CLI reference](cli.md#af-init)). This page is what those shapes are made of.

## Quick run

The base image is published to GitHub Packages as **`ghcr.io/loopedautomation/agent`** (public, multi-arch: amd64 + arm64, rebuilt by CI on every framework change). Run any agent by mounting its YAML:

```sh
docker run -d \
  -v ./agent.yaml:/agent/agent.yaml:ro \
  --env-file .env \
  -v agent-data:/data \
  ghcr.io/loopedautomation/agent:latest
```

(Building locally instead: `docker build -f images/agent/Dockerfile -t ghcr.io/loopedautomation/agent:latest .` from the repo root.)

## File-less deploys: config via env var

Platforms where env vars are easy but file mounts aren't (Coolify, Railway, Fly, any "image + env vars" form): put the YAML itself in `LOOPED_AGENT_CONFIG` and deploy the stock image with no files at all. The agent reads its definition from the env var; setting both the env var and a mounted `/agent/agent.yaml` is a startup error (never a guess). Skills need real files, so this route suits skill-less agents — bake a custom image otherwise.

### One compose file: the whole agent, inline

The same mechanism collapses a compose deploy to a single file — the agent's config embedded in the service definition:

```yaml
# compose.yaml — no agent.yaml anywhere
services:
  time-bot:
    image: ghcr.io/loopedautomation/agent:latest
    environment:
      LOOPED_AGENT_CONFIG: |
        nickname: time-bot
        description: Answers questions, and knows what time it is.
        model:
          provider: openai-compatible
          id: gpt-5.4-mini
        purpose: |
          You are a concise assistant. Use current_time rather than guessing.
    env_file: .env
    volumes:
      - time-bot-data:/data
    restart: unless-stopped
volumes:
  time-bot-data:
```

`af init --deploy compose-inline` generates this shape. One thing to know: env references *inside the embedded config* must be written `$${VAR}` (double dollar) so compose passes them through for the runtime to resolve, instead of substituting the value into the config at deploy time.

## The custom-image story

The Dockerfile is the environment; the YAML is the agent. Need a CLI? Add a layer:

```dockerfile
FROM ghcr.io/loopedautomation/agent:latest
USER root
RUN apk add --no-cache github-cli
USER looped

# Optional: bake config + skills in for a self-contained, ship-anywhere artifact
COPY --chown=looped:looped skills/gh-issues.md /skills/gh-issues.md
COPY --chown=looped:looped agent.yaml /agent/agent.yaml
```

[`examples/issue-bot`](https://github.com/loopedautomation/agent-framework/tree/main/examples/issue-bot) is the complete pattern: Dockerfile + compose.yaml + `.env.example`. Deployment is:

```sh
cd examples/issue-bot && cp .env.example .env  # fill in your keys
docker compose up -d
```

A fleet is the same file, longer: each agent is one more service block with its own config, volume, and permissions. Need a second job done? Run a second agent — containers are cheap.

## What the base image gives you

- **Hardened by default**: non-root user (`looped`, uid 10001), bash for `run_bash`, nothing else — no browser, no extras. The compose example adds `read_only: true` + tmpfs.
- **Deno sandbox as layer 1**: reads scoped to `/agent`, `/skills`, `/data`, `/run/secrets`; writes to `/data` only; subprocess spawning limited to bash (which the permission engine then gates per-executable — [the layers](permissions.md#the-layers)).
- **Volumes**: `/data` holds the agent's SQLite (sessions, runs, audit, its chosen name). Persist it — a fresh volume is a fresh self.
- **Health**: `HEALTHCHECK` wired to the status surface; `docker ps` shows `healthy`.
- **Ports**: `8080` webhook trigger (if configured), `9090` status surface.

## The status surface

Every service agent exposes:

- `GET /healthz` — liveness + identity (nickname, chosen name, model, triggers, uptime). Unauthenticated.
- `GET /runs`, `GET /audit` — run history and permission decisions. Loopback-only unless `LOOPED_STATUS_TOKEN` is set, then bearer-token access.

```sh
curl -s localhost:9090/healthz | jq
```

`LOOPED_STATUS_HOST` and `LOOPED_STATUS_PORT` override the bind (the base image sets host `0.0.0.0`; publish the port loopback-only, as the compose examples do).

## Persistence: the data volume

Each agent owns one SQLite file — `/data/<nickname>.db` in the container (`LOOPED_DATA_DIR` elsewhere; default `.looped/` locally) — holding:

- **sessions/messages** — conversation history per conversation key (when `memory.scope: thread`)
- **runs** — every run: trigger, input, status, steps, tokens, cost, timestamps
- **audit** — every permission decision, allowed and denied
- **identity** — the name the agent chose on first boot

This is the whole accountability story in one file you can query: what did the agent do, what did it cost, and what did it try that we said no to. Persist the volume — a fresh volume is a fresh self, and the agent renames itself.

## Secrets

`--env-file .env` for simple setups; Compose `secrets:` (mounted at `/run/secrets/<NAME>`) resolve identically — config references like `${GITHUB_TOKEN}` check the env first, then the secrets file. Secrets never enter the model's context and are scoped per tool ([Permissions](permissions.md#secrets)).
