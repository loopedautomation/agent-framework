# Looped Agent Framework

**Looped AF** — a Docker-native, config-driven framework for building single-purpose, event-driven AI agents that automate business processes.

**Start with the [Manifesto](MANIFESTO.md).** Three minutes; it's the whole philosophy.

The idea: **an agent is a file** — one file that says the job, the model, the tools, and the boundaries — and deploying it is a `docker run`. Agents are long-running services that sit in a loop — wait for an event (a Discord message, a webhook, a cron tick), do their one job, deliver the result, go idle.

```yaml
handle: issue-bot     # agents name themselves; you just pick the handle
description: Turns team Discord messages into GitHub issues.
model: { provider: openai-compatible, id: gpt-5.4-mini }
triggers:
  - type: discord
    channels: ["issues"]
skills:
  - ./skills/gh-issues.md
permissions:
  net: [discord.com, gateway.discord.gg, api.github.com]
  run: [gh]
```

## What's here

- **The `af` CLI** — `af init` scaffolds a complete agent project (agent, secrets template, deployment shape); `af validate` checks it; `af run` runs it — an interactive REPL without triggers, a long-lived service with them.
- **Triggers** — Discord, Slack, and Telegram (including observer agents), webhook, cron.
- **Capability, added deliberately** — markdown [skills](skills/), MCP servers, a small native toolset, and tool search to keep schemas out of a small model's context.
- **Deny-by-default permissions** — allowlisted hosts, executables, and paths; scoped secrets that never enter the model's context; every decision in a SQLite audit trail.
- **Docker-native deployment** — the hardened `ghcr.io/loopedautomation/agent` base image, the one-`apk add` custom-image recipe, file-less env-var deploys, and a status surface (`/healthz`, `/runs`, `/audit`).
- **Budgets by default** — every run has a step cap, and cheap models are the default, so spending stays predictable.

## Docs

Published at **[docs.looped.sh/agent-framework](https://docs.looped.sh/agent-framework)**, authored in [`docs/`](docs/):

[Quick start](docs/quick-start.md) · [The agent file](docs/agent-file.md) · [Triggers](docs/triggers.md) · [Skills](docs/skills.md) · [Tools](docs/tools.md) · [Permissions](docs/permissions.md) · [Deployment](docs/deployment.md) · [CLI](docs/cli.md)

Or start from a complete, runnable agent: the [examples](examples/) go from a minimal REPL bot to the Discord → GitHub [issue-bot](examples/issue-bot/) (`docker compose up`) and the [agent-zero](examples/agent-zero/) — the agent that builds agents.

Runtime: [Deno](https://deno.com) + TypeScript. Pre-1.0, built in the open.
