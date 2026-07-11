# Deploying rememberall-bot

Goal: a Discord bot you can hand a fact and get it back later, and one that keeps appointments: "remind me Thursday to call the accountant" produces a message in the channel on Thursday. Budget ~20 minutes; no framework knowledge needed.

Two blocks of config do the work. [`memory.persistent`](../../docs/memory.md) gives the agent remember/recall tools backed by its own SQLite file, and [`schedules:`](../../docs/scheduling.md) lets it file future runs of itself, with the result delivered back to the channel that asked.

## What you need before starting

- **Manage Server** permission on your Discord
- An OpenAI API key
- Somewhere to run a container: any Docker host, or Coolify (section below)

## 1. Create the Discord bot (~10 min)

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → name it (e.g. `rememberall`).
2. **Bot** tab → under *Privileged Gateway Intents*, enable **Message Content Intent**. ⚠️ This is the step everyone misses; without it the bot receives empty messages and silently does nothing.
3. **Bot** tab → *Reset Token* → copy the token. This is `DISCORD_BOT_TOKEN`.
4. Invite the bot: if you have the repo + Deno, `DISCORD_BOT_TOKEN=... deno task af discord-invite examples/rememberall-bot/agent.yaml` prints the ready-made invite URL. Otherwise use **OAuth2 → URL Generator**: scope `bot`; permissions **View Channels**, **Send Messages**, **Read Message History**.
5. Create a `#rememberall` channel and make sure the bot can see it. (To listen elsewhere, edit `channels:` in `agent.yaml`.)

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
3. Add `OPENAI_API_KEY` and `DISCORD_BOT_TOKEN` as environment variables in the resource's **Environment Variables** tab; the compose file's `env_file: .env` line can be deleted in the Coolify editor if you'd rather keep everything in the UI.
4. Deploy. The bot connects outward to Discord over the gateway, so no domain, port mapping or reverse proxy is needed. Leave the `9093` status port unpublished, or map it if you want `/healthz` reachable from the Coolify host.

The one thing to protect is the `rememberall-bot-data` volume: memories, schedules and conversation history all live in that one SQLite file. Coolify keeps named volumes across redeploys, so a redeploy loses nothing; deleting the resource deletes the remembrall's mind.

## 3. Verify

```sh
docker compose ps                # should say "healthy" after ~15s
curl -s localhost:9093/healthz   # identity JSON — note the agent's chosen name
```

Then, in `#rememberall`:

> **Ratul:** remember that the office wifi password is duckling-crumpet-42
> **bot:** Saved. I'll keep "office wifi password" until you tell me otherwise.
>
> **Happy:** what's the wifi password?
> **bot:** duckling-crumpet-42.
>
> **Amin:** remind me on Thursday at 9am to call the accountant
> **bot:** Scheduled: I'll remind you here Thursday 09:00.
>
> *(Thursday, 09:00)*
> **bot:** Reminder: call the accountant.

`/status` in the channel shows run totals; `list_schedules` is one message away ("what reminders do you have for Gwinyai?").

## How it holds up

- A container restart changes nothing: memories, history and schedules are all in the data volume, and a reminder that came due while the container was down fires as soon as it starts again.
- Reminders are at-least-once. A crash at exactly the wrong moment can repeat one; it can't silently drop one.
- The agent holds at most 20 schedules (`schedules.max`); past that it refuses and asks to cancel one first.
- Anyone the trigger admits can read and write memories and file reminders. The channel filter is the audience control, so put the bot in a channel with exactly the people whose remembrall it is.
