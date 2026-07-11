# Deploying rememberall-bot

Goal: a Telegram bot you can hand a fact and get it back later, and one that keeps appointments: "remind me Thursday to call the accountant" produces a message in the chat on Thursday. Budget ~15 minutes; no framework knowledge needed.

Two blocks of config do the work. [`memory.persistent`](../../docs/memory.md) gives the agent remember/recall tools backed by its own SQLite file, and [`schedules:`](../../docs/scheduling.md) lets it file future runs of itself, with the result delivered back to the chat that asked.

## What you need before starting

- A Telegram account
- An OpenAI API key
- Somewhere to run a container: any Docker host, or Coolify (section below)

## 1. Create the Telegram bot (~2 min)

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → pick a display name and a username. It replies with the token; this is `TELEGRAM_BOT_TOKEN`.
2. In `agent.yaml`, replace `ratulmaharaj` in `from_users` with your own username (bare, no `@`). Anyone who finds the bot can DM it, so this list is who the remembrall belongs to; add family or teammates by adding entries. A numeric user id works too and survives a username change ([@userinfobot](https://t.me/userinfobot) tells you yours) — better for your own deployment, though not something to commit to a public repo.

That's the whole registration; the bot connects outward by long-polling, so Telegram never needs to reach your server.

## 2. Deploy with Docker Compose (~5 min)

In this directory:

```sh
cp .env.example .env     # fill in the two values; never commit .env
docker compose up -d --build
```

The base image is pulled from `ghcr.io/loopedautomation/agent` (public, no login needed).

## 2b. Or deploy on Coolify

Coolify builds this straight from the repo:

1. **New Resource** → **Docker Compose** → point it at your fork or clone of this repository (public repo works without a deploy key).
2. Set **Base Directory** to `/examples/rememberall-bot` so Coolify picks up this `compose.yaml`. The build context reaches back to the repo root, which Coolify's checkout handles.
3. Add `OPENAI_API_KEY` and `TELEGRAM_BOT_TOKEN` as environment variables in the resource's **Environment Variables** tab; the compose file's `env_file: .env` line can be deleted in the Coolify editor if you'd rather keep everything in the UI.
4. Deploy. The bot polls Telegram outward, so no domain, port mapping or reverse proxy is needed. Leave the `9093` status port unpublished, or map it if you want `/healthz` reachable from the Coolify host.

The one thing to protect is the `rememberall-bot-data` volume: memories, schedules and conversation history all live in that one SQLite file. Coolify keeps named volumes across redeploys, so a redeploy loses nothing; deleting the resource deletes the remembrall's mind.

## 3. Verify

```sh
docker compose ps                # should say "healthy" after ~15s
curl -s localhost:9093/healthz   # identity JSON — note the agent's chosen name
```

Then DM the bot:

> **Ratul:** remember that the office wifi password is duckling-crumpet-42
> **bot:** Saved. I'll keep "office wifi password" until you tell me otherwise.
>
> **Ratul:** what's the wifi password?
> **bot:** duckling-crumpet-42.
>
> **Ratul:** remind me on Thursday at 9am to call the accountant
> **bot:** Scheduled: I'll remind you here Thursday 09:00.
>
> *(Thursday, 09:00)*
> **bot:** Reminder: call the accountant.

`/status` shows run totals, and the bot will list its reminders if you ask ("what have I asked you to remember for this week?"). It also works in a group: add the bot, list the members in `from_users`, and the group chat becomes a shared remembrall for Ratul, Amin, Happy and Gwinyai alike.

## How it holds up

- A container restart changes nothing: memories, history and schedules are all in the data volume, and a reminder that came due while the container was down fires as soon as it starts again.
- Reminders are at-least-once. A crash at exactly the wrong moment can repeat one; it can't silently drop one.
- The agent holds at most 20 schedules (`schedules.max`); past that it refuses and asks to cancel one first.
- There is no `permissions:` block, and that's the point: the agent's only tools are memory, schedules and the clock, so there is nothing else it can touch. `from_users` decides whose remembrall it is.
