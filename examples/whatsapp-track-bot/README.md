# Deploying whatsapp-track-bot

Capture work into [Looped Track](https://looped.sh) by messaging WhatsApp. You tell it what you did or what you need to do, and it files the time entry or the todo for you.

The point is capture where you already are. A todo you have to open a laptop to file is a todo you don't file, and WhatsApp is the app already open on the phone in your hand.

## Read this before you build it

Meta's [Business Solution Terms](https://www.whatsapp.com/legal/business-solution-terms) forbid using the WhatsApp Business Platform to provide a general-purpose AI assistant as the primary functionality, and have done since enforcement completed on 2026-01-15. What is allowed is a business running an assistant for its own operations, which is what this is: it files todos and time entries against one API and declines everything else. The narrowness is the compliance argument as much as it is the design.

If what you want is a personal assistant you can chat to, use [`rememberall-bot`](../rememberall-bot/) on Telegram. It costs nothing and asks no permission.

Full channel setup, including the webhook handshake and the 24-hour window, is in [the WhatsApp docs](../../docs/whatsapp.mdx).

## What you need before starting

- A [Looped](https://looped.sh) account with Track, and permission to create API keys (owner or admin).
- A Meta app with the WhatsApp product added, and a phone number registered to it.
- Somewhere to host this with a **public HTTPS URL**. The Cloud API is webhook-only, so there is no laptop-only path.
- An OpenAI API key.
- Docker, for the compose file.

## 1. Get a Looped API key (~3 min)

In the manage app, Settings → API Keys. Give the key the `read:todo`, `write:todo`, `read:time`, `write:time` and `read:project` scopes; the last one is what lets the agent turn a spoken project name into an id. The raw key is shown once, so copy it then. It looks like `looped_live_…`.

Use a `looped_test_…` key while you're getting the phrasing right, so a misparsed message doesn't land in real timesheets.

## 2. Create the Meta app (~30 min, plus verification)

Add the WhatsApp product to a Business-type app, get a test number, and copy the **Phone number ID** (not the phone number) into `agent.yaml`. You also need three secrets: a system user access token, the app secret from Settings → Basic, and a verify token you invent yourself (`openssl rand -hex 16`).

Business verification and a display name review are what let numbers other than your nominated test recipients reach the agent. That part is Meta's timeline, not yours.

## 3. Deploy (~5 min)

Set `public_url` in `agent.yaml` to wherever you're deploying, and put your own number in `from_numbers`. Then put your secrets in `.env` next to `compose.yaml`:

```
OPENAI_API_KEY=sk-...
LOOPED_API_KEY=looped_live_...
WHATSAPP_TOKEN=EAA...              # system user token
WHATSAPP_APP_SECRET=...            # App Dashboard → Settings → Basic
WHATSAPP_VERIFY_TOKEN=...          # anything: openssl rand -hex 16
```

```sh
docker compose up -d
```

## 4. Register the webhook (~2 min)

The agent has to be running for this, because the handshake is a live request. In the app's WhatsApp → Configuration panel, set the callback URL and the verify token, then subscribe to the `messages` field. The agent logs the exact callback URL at startup, ready to paste:

```
whatsapp trigger listening on :8080/whatsapp — callback URL: https://your-host/whatsapp
```

## 5. Verify

Message the number from a phone listed in `from_numbers`:

> **you:** remind me to send the Acme invoice on Friday
> **bot:** Filed: send the Acme invoice, due Fri 12 Dec.
>
> **you:** 2 hours on the Acme redesign yesterday
> **bot:** Logged: 2h on Acme redesign, Thu 11 Dec.
>
> **you:** what's on my list?
> **bot:** Send the Acme invoice (Fri), renew the domain (Mon), call the accountant (no date).

`curl localhost:9099/healthz` tells you the agent is up; `curl localhost:9099/runs` shows what it has done.

## What it demonstrates

- **The `whatsapp` channel.** The Cloud API webhook, signature verification, deduplication on the message id, and replies converted into WhatsApp's own markup.
- **`http.auth` with a non-Bearer scheme.** Looped authenticates with `X-API-Key: looped_live_…`. The runtime attaches it after the tool call is authorised, so the key never enters model context and can't be leaked into a reply.
- **One host in `permissions.net`.** You write `api.looped.sh`; the channel's own hosts are derived from the trigger, so `af validate` shows the full list the agent actually runs under. There is no shell.
- **A purpose that carries an API contract.** The endpoints, the required fields and the two format traps are in the prompt, because a cheap model gets those wrong on general knowledge. `dueDate` has to be ISO 8601 with an offset, and there is no timer to start or stop: you post a duration in whole seconds that has already elapsed.

## One key is one person

This is the design constraint worth understanding before you hand the number to anyone. A Looped API key acts as **the user who created it**. Todos are per-user within a team, and a time entry is logged against the key's owner unless an admin passes `userId` to log on someone else's behalf.

So this agent is one person's capture line rather than a team's. `from_numbers` lists exactly the one number belonging to whoever owns the key. A colleague who wants the same thing gets their own deployment with their own key and their own WhatsApp number, which is the shape the framework prefers anyway: one agent, one job, one owner.

Leaving `from_numbers` off would mean anyone who found the number could file work under your name. Don't.
