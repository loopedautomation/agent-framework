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

Building — M1 (core loop) is code-complete: you can define an agent in YAML and run it interactively today. See **[Getting started](docs/getting-started.md)**. Triggers, permissions, skills, MCP, and Docker packaging are next ([roadmap](plans/003-roadmap.md)).

The plans are the source of truth:

- [Plan 0 — Vision](plans/000-vision.md): why this exists, principles, non-goals
- [Plan 1 — Architecture](plans/001-architecture.md): core concepts and design
- [Plan 2 — MVP](plans/002-mvp.md): the Discord → GitHub issue agent
- [Plan 3 — Roadmap](plans/003-roadmap.md): milestones, starting with the manifesto
- [Plan 4 — Landscape](plans/004-landscape.md): positioning against eve, Docker Agent, n8n & co.
- [Plan 5 — Platform](plans/005-platform.md): hosted platform, service business, agent hub

Runtime: [Deno](https://deno.com) + TypeScript.
