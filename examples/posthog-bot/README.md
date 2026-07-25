# Deploying posthog-bot

Goal: an analytics analyst you can ask plain-language questions — "how many signups this week?", "what are our top pages?" — over Telegram or a hosted terminal. It writes HogQL, runs it against PostHog's query API, and answers with the numbers. Say "send me DAU every morning" and a [schedule](../../docs/scheduling.md) does exactly that. Budget ~10 minutes.

The agent's only capability is `http_request` against one PostHog host, and a [skill](../../skills/posthog.md) teaches it the query endpoint and the HogQL dialect. The API key is declared in `http.auth`, so the runtime attaches it server side and the key never appears in model context ([secrets](../../docs/secrets.md)).

## What you need before starting

- A PostHog project (cloud or self-hosted) and a personal API key
- A Telegram account and an OpenAI API key

## 1. Point it at your project (~2 min)

1. In PostHog: your avatar → Personal API keys → create one scoped to **query:read** and your project. This is `POSTHOG_API_KEY`.
2. Find your numeric project id (Settings → Project, or the number in the PostHog URL). This is `POSTHOG_PROJECT_ID` — the purpose references it as `${POSTHOG_PROJECT_ID}`, resolved at startup like any other env reference.
3. On EU cloud or self-hosted, replace `us.posthog.com` in `agent.yaml` in all three places it appears (purpose, `permissions.net`, `http.auth`).

Verify the key works:

```sh
curl -s https://us.posthog.com/api/projects/<id>/query \
  -H "Authorization: Bearer $POSTHOG_API_KEY" -H 'Content-Type: application/json' \
  -d '{"query": {"kind": "HogQLQuery", "query": "SELECT count() FROM events"}}'
```

## 2. Create the Telegram bot (~2 min)

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token; this is `TELEGRAM_BOT_TOKEN`.
2. In `agent.yaml`, replace `ratulmaharaj` in `from_users` with your own username (bare, no `@`). The bot can read everything in your analytics project, so keep the list tight.

## 3. Run it

On the machine directly:

```sh
export OPENAI_API_KEY=... TELEGRAM_BOT_TOKEN=... POSTHOG_API_KEY=... POSTHOG_PROJECT_ID=... TTY_TOKEN=...
af run examples/posthog-bot/agent.yaml
```

Or as a container:

```sh
cp .env.example .env     # fill in the five values; never commit .env
docker compose up -d
```

The [TTY trigger](../../docs/tty.md) is on alongside Telegram: connect a WebSocket client to `ws://localhost:8090/tty` with `Authorization: Bearer $TTY_TOKEN` and you get the same agent — same memory, same permissions — streaming its run live.

## 4. Try it

> **Ratul:** how many signups did we get this week?
> **bot:** 214 signups in the last 7 days, up from 187 the week before. I counted the `user signed up` event.
>
> **Ratul:** top pages?
> **bot:** `/` 4,102 · `/pricing` 1,377 · `/docs` 964 (pageviews, last 7 days)
>
> **Ratul:** send me DAU every morning at 8
> **bot:** Scheduled: daily at 08:00 I'll report yesterday's DAU here.

## The blast area

`net: [us.posthog.com]` is the whole capability surface: one read-only query endpoint, no shell, no files, no other host. The skill forbids anything but `/query`, and the API key's `query:read` scope enforces read-only at the server even if the model ignores that. The key itself is attached by the runtime, never shown to the model, and [redacted](../../docs/secrets.md) from logs and traces. What remains is data exposure — whoever is in `from_users` or holds `TTY_TOKEN` can read anything your analytics project contains — so both lists are the control that matters.
