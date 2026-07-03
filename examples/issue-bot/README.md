# Deploying issue-bot

Goal: a Discord bot that turns messages in `#issues` into GitHub issues and replies with the link. Budget ~30 minutes; no framework knowledge needed.

## What you need before starting

- Docker on the deploy machine, and a clone of this repo
- **Manage Server** permission on the team Discord
- Permission to create a GitHub fine-grained PAT for the target repo
- The team's OpenAI API key

## 1. Create the Discord bot (~10 min)

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → name it (e.g. `issue-bot`).
2. **Bot** tab → under *Privileged Gateway Intents*, enable **Message Content Intent**. ⚠️ This is the step everyone misses — without it the bot receives empty messages and silently does nothing.
3. **Bot** tab → *Reset Token* → copy the token. This is `DISCORD_BOT_TOKEN`.
4. **OAuth2 → URL Generator**: check scope `bot`; check permissions **View Channels**, **Send Messages**, **Read Message History**. Open the generated URL and invite the bot to the team server.
5. Make sure a `#issues` channel exists and the bot can see it.

## 2. Create the GitHub token (~5 min)

GitHub → Settings → Developer settings → [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new):

- Repository access: **only the target repo**
- Permissions: **Issues: Read and write** (Metadata: Read comes automatically)
- Copy the token. This is `GITHUB_TOKEN`.

## 3. Point the agent at the right repo (~2 min)

Edit `agent.yaml` in this directory: in `system_prompt`, replace the repository reference with the real one (e.g. `acme/product`). The agent adds `--repo` from what the prompt tells it.

## 4. Configure and deploy (~5 min)

In this directory:

```sh
cp .env.example .env     # fill in the three values; never commit .env
docker compose up -d --build
```

(The base image lives at `ghcr.io/loopedautomation/agent`, but the package isn't public yet — pulls currently fail with `unauthorized`. Until it is, build it locally from the repo root first: `docker build -f images/agent/Dockerfile -t ghcr.io/loopedautomation/agent:latest .`)

## 5. Verify

```sh
docker compose ps                      # should say "healthy" after ~15s
curl -s localhost:9090/healthz        # identity JSON — note the agent's chosen name
docker compose logs -f                # watch it connect to Discord
```

Then post in `#issues`:

> the CSV export breaks on files over 10MB, probably the streaming parser

You should get a reply with a GitHub issue link within seconds. Check the issue reads well.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Bot online but never replies | Message Content Intent not enabled (step 1.2) — the #1 failure mode |
| `discord: cannot reach gateway (401)` in logs | Bad `DISCORD_BOT_TOKEN` |
| Replies with a permission/auth error about GitHub | PAT lacks Issues write on the repo, or wrong repo in the prompt |
| `error_provider (auth)` in replies | Bad `OPENAI_API_KEY` |
| Want to see what it's been doing | `curl -s localhost:9090/runs` (from the deploy machine) |

The agent's memory, run history, and audit log live in the `issue-bot-data` Docker volume — deleting that volume gives it a fresh memory (and it will choose a new name for itself).
