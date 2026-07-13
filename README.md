# Looped Agent Framework

Looped AF lets you build contained, event-driven AI agents. Define your agent in a single config file, run it in a container and deploy it anywhere.

> 🚧 **This is alpha software** 🚧 
>
> We're still in the early stages, and things are going to change and sometimes break: interfaces, config fields, defaults. If you're up for experimenting anyway, welcome. File an issue when something breaks and we'll sort it out.


The idea is that an agent is a file: one file that says the job, the model, the tools and the boundaries. Deploying it is a `docker run`. Agents run as long-lived services that sit in a loop; each one waits for an event (a Discord message, a webhook, a cron tick), does its one job, delivers the result and then goes idle.

```yaml
handle: issue-bot     # agents name themselves; you pick the handle
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

- **The `af` CLI.** `af init` scaffolds a complete agent project with the agent file, a secrets template and a deployment shape. `af validate` checks it and `af run` runs it: without triggers you get an interactive REPL, with them the agent runs as a service.
- **Triggers.** Discord, Slack and Telegram (including observer agents), plus webhooks and cron.
- **Capability, added deliberately.** Markdown [skills](skills/), MCP servers, a small native toolset and tool search, which keeps tool schemas out of a small model's context.
- **Deny-by-default permissions.** You allowlist the hosts, executables and paths an agent is allowed to touch. Secrets are scoped, and their values stay out of the model's context. Every permission decision lands in a SQLite audit trail.
- **Docker-native deployment.** We publish a hardened base image (`ghcr.io/loopedautomation/agent`), a one-`apk add` recipe for custom images and a status surface at `/healthz`, `/runs` and `/audit`. Deploys can be file-less, with everything passed through env vars.
- **Budgets by default.** Every run has a step cap and cheap models are the default, so you know roughly what an agent costs before you deploy it.

## Docs

Published at [docs.looped.sh/agent-framework](https://docs.looped.sh/agent-framework) and authored in [`docs/`](docs/):

[Quick start](docs/quick-start.mdx) · [The agent file](docs/agent-file.md) · [Triggers](docs/triggers.md) · [Skills](docs/skills.md) · [Tools](docs/tools.md) · [Permissions](docs/permissions.md) · [Deployment](docs/deployment.md) · [CLI](docs/cli.md)

If you'd rather start from a complete, runnable agent, the [examples](examples/) go from a minimal REPL bot to the Discord to GitHub [gh-issues-bot](examples/gh-issues-bot/) (`docker compose up`) and [agent-zero-bot](examples/agent-zero-bot/), the agent that builds agents.

The runtime is [Deno](https://deno.com) + TypeScript, built in the open.

## Contributing

Setup, local development tasks and what CI checks are covered in [CONTRIBUTING.md](CONTRIBUTING.md).
