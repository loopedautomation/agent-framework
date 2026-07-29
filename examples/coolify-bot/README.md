# Deploying coolify-bot

Goal: an operator for your [Coolify](https://coolify.io) instance you can talk to. "Deploy the api." "Is anything down?" "Why did the last deploy fail?" "Tail web's logs." Over Telegram or a hosted terminal, from your phone, without opening the dashboard. Budget ~10 minutes.

The agent's only capability is `http_request` against your Coolify host, and a [skill](coolify.md) teaches it the v1 REST API — the UUID-first workflow, the asynchronous deploy lifecycle, where build logs live versus runtime logs, and the failure modes. The API token is declared in `http.auth`, so the runtime attaches it server side and it never appears in model context ([secrets](../../docs/secrets.md)).

Because it spawns nothing and lists one exactly-matched host, it qualifies for [hermetic mode](../../docs/permission-model.md#hermetic-mode): the Deno sandbox itself holds the net allowlist, so your Coolify instance is the only address the process can reach. `af flags agent.yaml` prints the compiled flags.

## What you need before starting

- A Coolify instance (self-hosted or [Coolify Cloud](https://app.coolify.io)) with the API enabled
- A Telegram account and an Anthropic API key

## 1. Point it at your instance (~3 min)

1. In Coolify: **Keys & Tokens → API tokens → Create**. Scope it to the one team whose resources this agent should touch. A read-only token is a real option if you only want status and logs — see [the blast area](#the-blast-area).
2. Set `COOLIFY_HOST` to your instance's **bare hostname** — no scheme, no trailing slash. On Coolify Cloud that's `app.coolify.io`.

Nothing in `agent.yaml` needs editing: the host is an env reference in all three places it appears (`purpose`, `permissions.net`, `http.auth.url`), so your instance's address stays in `.env` rather than in a committed file. The reference resolves at startup, *before* the [sandbox flags](../../docs/permission-model.md#hermetic-mode) are compiled from it — so the host the runtime enforces is the real one, not the literal `${COOLIFY_HOST}`:

```sh
$ COOLIFY_HOST=coolify.example.com af flags agent.yaml
--allow-env --allow-read=… --allow-write=/data \
  --allow-net=0.0.0.0:9090,api.anthropic.com,api.telegram.org,0.0.0.0:8090,coolify.example.com
```

`af validate` describes rather than runs, so off the deployment host it leaves the reference visible and warns `not set in this environment` instead of failing. A real startup with it unset fails immediately, like any other missing reference.

Verify the token and that the API is on:

```sh
curl -s https://$COOLIFY_HOST/api/v1/version -H "Authorization: Bearer $COOLIFY_API_TOKEN"
curl -s https://$COOLIFY_HOST/api/v1/resources -H "Authorization: Bearer $COOLIFY_API_TOKEN" | head -c 500
```

A 401 here usually means the API is disabled on the instance rather than a bad token — Settings → API.

## 2. Create the Telegram bot (~2 min)

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token; this is `TELEGRAM_BOT_TOKEN`.
2. In `agent.yaml`, replace `ratulmaharaj` in `from_users` with your own username (bare, no `@`). Whoever is on that list can deploy and stop your services, so keep it to yourself.

## 3. Run it

On the machine directly:

```sh
export ANTHROPIC_API_KEY=... COOLIFY_HOST=... COOLIFY_API_TOKEN=... TELEGRAM_BOT_TOKEN=... TTY_TOKEN=...
af run examples/coolify-bot/agent.yaml
```

Or as a container:

```sh
cp .env.example .env     # fill in the five values; never commit .env
docker compose up -d
```

If you're running this *on* the Coolify host, keep it in its own container rather than as a Coolify resource — an agent that can restart its own platform is a fun way to lose the ability to fix it.

The [TTY trigger](../../docs/tty.md) is on alongside Telegram: connect a WebSocket client to `ws://localhost:8091/tty` with `Authorization: Bearer $TTY_TOKEN` and you get the same agent — same memory, same permissions — streaming its run live.

## 4. Try it

> **Ratul:** is anything down?
> **bot:** `web` is `running:unhealthy` — everything else is healthy (api, worker, postgres, redis). Its last deploy finished 20 minutes ago; the container is up but failing its health check on `/healthz`.
>
> **Ratul:** why?
> **bot:** Last 40 lines of `web`'s logs: it's exiting on `ECONNREFUSED 6379` at startup — it can't reach redis. Redis itself is `running:healthy`, so this looks like the `REDIS_URL` env var rather than the service. `web` has `REDIS_URL` set; I won't print the value. Want me to compare it against redis's internal hostname?
>
> **Ratul:** deploy the api
> **bot:** Deploying `api` (uuid `k8ss0oc`). Deployment `nc4wgk0scc`, queued. …*(a minute later)* Finished — `api` is `running:healthy`.

## The CLI variant

Sometimes the fix isn't in the platform, it's in the code. `agent.cli.yaml` adds headless [Claude Code](https://code.claude.com) plus git and gh, so "the build is failing on a type error — fix it and redeploy" becomes: clone, fix, push, then `POST /deploy`.

```sh
docker compose -f compose.cli.yaml up -d --build
```

The `Dockerfile` extends the base image with node, the claude CLI, git and gh, and `HOME` moves to `/data/home` so claude's state and repo clones live on the volume while the rootfs stays read-only. Add `GH_TOKEN` to `.env`.

**What it costs:** `permissions.run` means the agent spawns subprocesses, and a subprocess opens its own sockets that `permissions.net` never sees. That disqualifies the agent from hermetic mode — the container becomes the egress boundary instead of the Deno sandbox. `af flags agent.cli.yaml` names the grant that did it. Both files are here so the trade is yours to make; the hermetic one is the default for a reason.

To run the orchestrator on a Claude Pro/Max subscription rather than metered billing, `claude setup-token`, put the `sk-ant-oat01-...` value in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`, and point `api_key_env` at it — noting the [disclaimer](../../docs/anthropic.md#claude-subscription-auth). The embedded CLI draws on the subscription natively either way, which is the officially supported path.

## The blast area

This agent can deploy, restart, stop and delete your infrastructure, and read every environment variable in it. That is the point of it, and it's worth being clear-eyed about.

`net: ["${COOLIFY_HOST}"]` bounds *where* it can go — one host, enforced by the runtime rather than only the permission engine. What it can do *there* is bounded by one thing: **the API token's scope.** Scope it to a single team. If you mostly want a status-and-logs agent, issue a read-only token and the destructive half of the skill becomes unreachable regardless of what the model decides.

Two specifics the skill leans on hard, both defaults rather than enforcement:

- **Env var values are never printed.** `GET /envs` returns them in plaintext, and the skill and purpose both forbid echoing them. If that guarantee needs to be real rather than instructed, use a token without env access.
- **Deletes and stops require confirmation.** `DELETE /databases/{uuid}` takes the data with it. The skill says restate-then-act; a read-only or non-destructive token is what makes that structural.

And `from_users` plus `TTY_TOKEN` are who gets to ask. On an agent that can stop production, that list is the first control, not the last.
