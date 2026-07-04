---
title: "Triggers"
description: "Webhook, cron, and Discord — the events that wake the agent, and the service loop around them."
---

Triggers are what make an agent a service. The loop is the whole point: wait for an event, act, deliver the result, go idle. An agent with `triggers:` in its config runs as a long-lived service under `af run`; without them, the same command gives you an interactive REPL — the fastest way to iterate on a `purpose` before wiring up events.

Each trigger delivers its own result: the webhook responds to the caller, Discord replies in-channel, cron logs. Every run — whatever the trigger — lands in the agent's [run history](deployment.md#persistence-the-data-volume) with its status, steps, tokens, and cost.

## Webhook

```yaml
triggers:
  - type: webhook
    # path: /            (default)
    # port: 8080         (default)
    token_env: WEBHOOK_TOKEN   # required — bearer auth, deny by default
```

Call it:

```sh
curl -s localhost:8080 \
  -H "authorization: Bearer $WEBHOOK_TOKEN" \
  -H "content-type: application/json" \
  -d '{"input": "run: echo hello", "conversation_id": "demo"}'
```

The response is the run result: `{"status": "ok", "reply": "...", "steps": 2, "cost_usd": 0.0001}`. Pass the same `conversation_id` to continue a conversation (with `memory.scope: thread`); omit it for one-shot runs.

`token_env` is required — an unauthenticated endpoint contradicts deny-by-default. The token resolves at startup, and a missing env var fails then, not on the first request.

## Cron

```yaml
triggers:
  - type: cron
    schedule: "0 9 * * 1"        # every Monday 09:00
    prompt: Post a summary of open issues.
```

Each tick runs the agent with `prompt` as input. Results are logged and recorded in the run history (a configurable result sink is planned).

## Discord

```yaml
triggers:
  - type: discord
    channels: ["issues"]        # names or ids; omit for all channels
    # require_mention: true     # only respond when @-mentioned
    # token_env: DISCORD_BOT_TOKEN (default)
    # from_users: ["amin"]      # only handle these authors (user ids or usernames)
    # reply_channel: "1522..."  # post replies here instead of the source channel
    # allow_silence: true       # a reply of exactly __NO_REPLY__ posts nothing
```

Setup (the one genuinely irreducible ritual — budget 15 minutes):

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot.
2. Enable the **Message Content Intent** under Privileged Gateway Intents (without it, messages arrive empty — this is the #1 failure mode).
3. Copy the bot token → `export DISCORD_BOT_TOKEN=...`
4. `af discord-invite agent.yaml` prints the ready-made invite URL (correct scopes and permissions, no bitfield math) — open it and invite the bot to your server.
5. `deno task af run agent.yaml`

The agent replies in-channel to the triggering message; conversations are keyed per channel/thread (`memory.scope: thread` continues them). It ignores bots, itself, and empty messages; long replies split at Discord's 2000-char limit.

### Observer agents

The three optional keys together turn the trigger from a chatbot into an observer — an agent that watches channels, reacts to specific people, and reports elsewhere (a review bot, a moderation assistant, a coach):

- `from_users` — handle only these authors. The filter runs *before* the model is called: everyone else's messages are dropped in the trigger and never reach the provider.
- `reply_channel` — deliver replies to a dedicated channel instead of the source. Out-of-channel replies quote the triggering message and link back to it.
- `allow_silence` — let the agent say nothing. Instruct it in `purpose` to answer with exactly `__NO_REPLY__` when it has no feedback; the trigger then posts nothing instead of a "looks fine" reply on every message.

## Conversations

With `memory.scope: thread`, the agent remembers per conversation — and each trigger defines what "a conversation" is:

| Trigger | Conversation key |
| --- | --- |
| Discord | the channel or thread |
| Webhook | the caller's `conversation_id` |
| REPL | the CLI session |

With the default `scope: none`, every event is a fresh start. Either way, history lives in the agent's own SQLite file — see [the data volume](deployment.md#persistence-the-data-volume).
