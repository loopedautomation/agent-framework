# Deployment: the container is the computer

Status: covers M4. One agent per container; a fleet is a compose file.

## Quick run

Build the base image (until it's published to a registry):

```sh
docker build -f images/agent/Dockerfile -t looped/agent .
```

Run any agent by mounting its YAML:

```sh
docker run -d \
  -v ./agent.yaml:/agent/agent.yaml:ro \
  --env-file .env \
  -v agent-data:/data \
  looped/agent
```

## The custom-image story

The Dockerfile is the environment; the YAML is the agent. Need a CLI? Add a layer:

```dockerfile
FROM looped/agent
USER root
RUN apk add --no-cache github-cli
USER looped

# Optional: bake config + skills in for a self-contained, ship-anywhere artifact
COPY --chown=looped:looped skills/gh-issues.md /skills/gh-issues.md
COPY --chown=looped:looped agent.yaml /agent/agent.yaml
```

[`examples/issue-bot`](../examples/issue-bot/) is the complete pattern: Dockerfile + compose.yaml + `.env.example`. Deployment is:

```sh
cd examples/issue-bot && cp .env.example .env  # fill in your keys
docker compose up -d
```

## What the base image gives you

- **Hardened by default**: non-root user (`looped`, uid 10001), bash for `run_bash`, nothing else — no browser, no extras (Plan 0, principle 8). The compose example adds `read_only: true` + tmpfs.
- **Deno sandbox as layer 1**: reads scoped to `/agent`, `/skills`, `/data`, `/run/secrets`; writes to `/data` only; subprocess spawning limited to bash (which the permission engine then gates per-executable).
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

## Secrets

`--env-file .env` for simple setups; Compose `secrets:` (mounted at `/run/secrets/<NAME>`) resolve identically — config references like `${GITHUB_TOKEN}` check the env first, then the secrets file. Secrets never enter the model's context and are scoped per tool (see [service-agents](service-agents.md)).

## Honest notes on the sandbox

- The Deno layer allows all *network* egress (`--allow-net`): per-host enforcement happens app-level in the permission engine, and the container's egress policy is layer 2 — restrict it with your network setup where it matters. Automating per-agent egress policy is on the roadmap.
- `bash` subprocesses escape the Deno sandbox by design; the container boundary is what contains them. That's why there is no "run on the host" mode.
