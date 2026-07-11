# Deploying qbit-bot

Goal: a Telegram bot that runs your qBittorrent server. Paste a magnet link and it queues the download, ask "what's downloading?" and get one line per torrent, say "tell me when it's done" and a [schedule](../../docs/scheduling.md) reports back. Budget ~15 minutes.

The agent's only capability is `http_request` against the qBittorrent Web API, and a [skill](../../skills/qbittorrent.md) teaches it the endpoints. This is the framework's preferred shape for an integration: an allowlisted API plus a page of instructions, and no other surface.

## What you need before starting

- A running qBittorrent with its Web UI enabled (Options → Web UI)
- A Telegram account and an OpenAI API key

## 1. Let the agent talk to qBittorrent (~3 min)

The agent cannot log in with a username and password: qBittorrent's login hands back a session cookie, and the `http_request` tool doesn't carry cookies between calls. The server has to trust requests from where the agent runs instead. In qBittorrent, Options → Web UI:

- Agent on the same machine as a native qBittorrent: tick **Bypass authentication for clients on localhost**.
- qBittorrent in Docker: requests from the host arrive from the Docker network, so localhost bypass won't match. Tick **Bypass authentication for clients in whitelisted IP subnets** and add your Docker subnet (commonly `172.16.0.0/12`) or your LAN subnet.

Verify before going further; this returns the version once the bypass applies:

```sh
curl http://localhost:8080/api/v2/app/version
```

The example assumes the Web UI's default port 8080. A different address means editing the two `localhost:8080` references in `agent.yaml` (purpose and `permissions.net`).

## 2. Create the Telegram bot (~2 min)

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token; this is `TELEGRAM_BOT_TOKEN`.
2. In `agent.yaml`, replace `ratulmaharaj` in `from_users` with your own username (bare, no `@`). This bot can delete downloaded files, so the list matters more than usual.

## 3. Run it

On the machine directly:

```sh
export OPENAI_API_KEY=... TELEGRAM_BOT_TOKEN=...
af run examples/qbit-bot/agent.yaml
```

Or as a container: change the two `localhost` references in `agent.yaml` to `host.docker.internal` (inside a container, localhost is the container), then:

```sh
cp .env.example .env     # fill in the two values; never commit .env
docker compose up -d
```

## 4. Try it

> **Ratul:** magnet:?xt=urn:btih:…
> **bot:** Added: ubuntu-24.04.2-live-server-arm64.iso. Downloading.
>
> **Ratul:** what's downloading?
> **bot:** ubuntu-24.04.2 — downloading, 34%, 11.2 MB/s
>
> **Ratul:** tell me when it's done
> **bot:** Scheduled: I'll check in 20 minutes and report here.

## The blast area

Everything this agent can do is one line of config: `net: [localhost]`. It can reach the qBittorrent API and nothing else; there is no shell, no file access and no other host. The real risk is qBittorrent's delete-with-files action, which the skill fences behind an explicit "delete the files too" from you, repeated back before it acts. Every API call the agent makes is visible in the [audit trail](../../docs/docker-run.md), and `from_users` decides who can speak to it at all.
