# Looped Agent Framework

**Looped AF** — a Docker-native, config-driven framework for building single-purpose, event-driven AI agents that automate business processes.

**Start with the [Manifesto](MANIFESTO.md).** Three minutes; it's the whole philosophy.

The idea: describing an agent should be a YAML file, and deploying it should be a `docker run`. Agents are long-running services that sit in a loop — wait for an event (a Discord message, a webhook, a cron tick), do their one job, deliver the result, go idle.

```yaml
nickname: issue-bot   # agents name themselves; you just give them a handle
description: Turns team Discord messages into GitHub issues.
model: { provider: anthropic, id: claude-sonnet-5 }
triggers:
  - type: discord
    channels: ["issues"]
tools:
  mcp:
    - name: github
      command: ["docker", "run", "-i", "ghcr.io/github/github-mcp-server"]
      env:
        GITHUB_TOKEN: ${GITHUB_TOKEN}
permissions:
  net: [discord.com, gateway.discord.gg, api.github.com]
```

## Status

Building — M4 is code-complete: the **`looped/agent` base image** (hardened, non-root, health-checked), the **custom-image recipe** (`FROM looped/agent` + one `apk add`), the **status surface** (`/healthz`, `/runs`, `/audit`), and the issue-bot as a **self-contained `docker compose up`** ([examples/issue-bot](examples/issue-bot/)) — on top of skills, MCP, Discord/webhook/cron triggers, deny-by-default permissions, and the SQLite audit trail. Docs: **[Getting started](docs/getting-started.md)** · **[Service agents](docs/service-agents.md)** · **[Skills & tools](docs/skills-and-tools.md)** · **[Deployment](docs/deployment.md)**. Next: live deployment + M5, the agent that builds agents ([roadmap](plans/003-roadmap.md)).

The plans are the source of truth:

- [Plan 0 — Vision](plans/000-vision.md): why this exists, principles, non-goals
- [Plan 1 — Architecture](plans/001-architecture.md): core concepts and design
- [Plan 2 — MVP](plans/002-mvp.md): the Discord → GitHub issue agent
- [Plan 3 — Roadmap](plans/003-roadmap.md): milestones, starting with the manifesto
- [Plan 4 — Landscape](plans/004-landscape.md): positioning against eve, Docker Agent, n8n & co.
- [Plan 5 — Platform](plans/005-platform.md): hosted platform, service business, agent hub

Runtime: [Deno](https://deno.com) + TypeScript.
