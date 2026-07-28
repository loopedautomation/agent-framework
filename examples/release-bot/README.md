# Deploying release-bot

Goal: a Telegram bot that cuts releases. Say "release v0.12 of owner/repo" and the agent delegates the whole job — clone, version bump, changelog, tag, release PR — to a headless [Claude Code](https://code.claude.com) run inside the container, then replies with the PR link. Budget ~10 minutes.

This example is the reference for the **embedded-CLI pattern**: the looped agent is a thin orchestrator (triggers, conversation, memory) and the heavy agentic work happens in `claude -p` subprocess runs. Both halves authenticate with a Claude Pro/Max subscription token — the orchestrator through the [anthropic provider's subscription auth](../../docs/anthropic.md#claude-subscription-auth), and the CLI natively, which is the officially supported way to draw on a subscription. Note the [disclaimer](../../docs/anthropic.md#claude-subscription-auth) on the orchestrator half; if you'd rather keep it unambiguous, point `model` at an API key and let only the CLI use the subscription.

## What you need before starting

- A Claude Pro/Max subscription and the Claude Code CLI installed locally (for `claude setup-token`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A fine-grained GitHub PAT with `contents: rw` and `pull_requests: rw` on the repos it will release

## 1. Mint the subscription token (~1 min)

```sh
claude setup-token
```

Paste the `sk-ant-oat01-...` value into `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. It draws from your plan's usage windows, not metered billing — a long release run competes with your own interactive Claude usage.

## 2. Deploy (~5 min)

In this directory:

```sh
cp .env.example .env     # fill in the three values; never commit .env
docker compose up -d --build
```

The Dockerfile extends the base image with node, the claude CLI, git and gh. `HOME` moves to `/data/home` so claude's state and the repo clones live on the volume while the rootfs stays read-only.

## 3. Verify

```sh
docker compose ps                # "healthy" after ~15s
curl -s localhost:9095/healthz   # identity JSON
```

Then message the bot:

> **You:** release v0.12.0 of loopedautomation/agent-framework
>
> **release-bot:** *(a few minutes later)* Release PR is up: https://github.com/loopedautomation/agent-framework/pull/171 — bumped to v0.12.0, changelog covers 14 commits since v0.11.1.

## How the delegation works

The agent's only `run` grant is `claude`. Each release is one tool call: the orchestrator composes a task prompt, spawns `claude -p "<task>" --output-format json --dangerously-skip-permissions`, and parses the JSON result. Skipping the CLI's own permission prompts is the container's job to make safe — the framework's [permission model](../../docs/permission-model.md) treats the container as the outer wall, and this container can reach nothing but what its tokens allow.

The inner run is a full agent with its own loop, so `limits.max_steps` stays small: one delegation is one step, however many steps Claude Code takes inside it.
