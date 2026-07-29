# Deploying github-bot

Goal: a GitHub agent for your *whole account*, not one repo. Ask "what needs my review?", "did CI pass on agent-framework?", "open an issue on qbit-bot about the stalled-torrent bug" over Telegram or a hosted terminal, and get the answer with links. Say "tell me every morning what's waiting on me" and a [schedule](../../docs/scheduling.md) does exactly that. Budget ~10 minutes.

The agent's only capability is `http_request` against `api.github.com`, and a [skill](github-profile.md) teaches it the profile-wide corners of the REST API — the notifications inbox, cross-repo search, the review queue, Actions — plus the response-size rules that matter when the tool caps bodies at 8k. The PAT is declared in `http.auth`, so the runtime attaches it server side and it never appears in model context ([secrets](../../docs/secrets.md)).

Because it spawns nothing and lists one exactly-matched host, it qualifies for [hermetic mode](../../docs/permission-model.md#hermetic-mode): the Deno sandbox itself holds the net allowlist, so `api.github.com` is the only address the process can reach — not a policy the agent is asked to respect, but a wall it runs inside. `af flags agent.yaml` prints the compiled flags.

## What you need before starting

- A GitHub account and a personal access token
- A Telegram account and an Anthropic API key

## 1. Mint the token (~3 min)

Settings → Developer settings → Personal access tokens. A fine-grained token scoped to the repos you want is the tighter choice; a classic token is simpler if you want the whole account. Useful scopes:

| Scope | What it unlocks |
|---|---|
| `repo` | private repos, and `/search/code` |
| `notifications` | the inbox — the best single "what needs me" surface |
| `workflow` | dispatching and rerunning Actions |
| `gist` | gists |

**The agent can do anything this token can do.** Start read-only if you want to watch it for a day first — a fine-grained token with contents/issues/PRs at *Read* covers every question and none of the mutations.

Check it works:

```sh
curl -s https://api.github.com/user -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H 'Accept: application/vnd.github+json' | head -20
```

## 2. Create the Telegram bot (~2 min)

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token; this is `TELEGRAM_BOT_TOKEN`.
2. In `agent.yaml`, replace `ratulmaharaj` in `from_users` with your own username (bare, no `@`). Whoever is on that list can act on your account through the bot, so keep it to yourself.

## 3. Run it

On the machine directly:

```sh
export ANTHROPIC_API_KEY=... GITHUB_TOKEN=... TELEGRAM_BOT_TOKEN=... TTY_TOKEN=...
af run examples/github-bot/agent.yaml
```

Or as a container:

```sh
cp .env.example .env     # fill in the four values; never commit .env
docker compose up -d
```

The [TTY trigger](../../docs/tty.md) is on alongside Telegram: connect a WebSocket client to `ws://localhost:8090/tty` with `Authorization: Bearer $TTY_TOKEN` and you get the same agent — same memory, same permissions — streaming its run live.

## 4. Try it

> **Ratul:** what needs my review?
> **bot:** 3 PRs are waiting on you — [#171 deploy CLI](https://github.com/loopedautomation/agent-framework/pull/171) (agent-framework, 2d), [#44 fix stalled-torrent detection](https://github.com/ratulmaharaj/qbit-bot/pull/44) (qbit-bot, 5h), [#9 bump deps](https://github.com/ratulmaharaj/dotfiles/pull/9) (dotfiles, 1w, draft).
>
> **Ratul:** did CI pass on the first one?
> **bot:** No — the latest run failed on `deno lint`. [Run 18442](https://github.com/loopedautomation/agent-framework/actions/runs/18442). Everything else was green.
>
> **Ratul:** tell me every morning at 8 what's waiting on me
> **bot:** Scheduled: daily at 08:00 I'll post your review queue and unread mentions here.

## The CLI variant

The REST API can't hand you raw Actions logs (they're a redirect to a signed URL, and `http_request` doesn't follow redirects), and it can't make a code change. `agent.cli.yaml` adds the `gh` CLI and headless [Claude Code](https://code.claude.com) for exactly those:

```sh
docker compose -f compose.cli.yaml up -d --build
```

The `Dockerfile` extends the base image with node, the claude CLI, git and gh, and `HOME` moves to `/data/home` so claude's state and repo clones live on the volume while the rootfs stays read-only.

**What it costs:** `permissions.run` means the agent spawns subprocesses, and a subprocess opens its own sockets that `permissions.net` never sees. That disqualifies the agent from hermetic mode — the container becomes the egress boundary instead of the Deno sandbox. `af flags agent.cli.yaml` names the grant that did it. Both files are here so the trade is yours to make; the hermetic one is the default for a reason.

To run the orchestrator on a Claude Pro/Max subscription rather than metered billing, `claude setup-token`, put the `sk-ant-oat01-...` value in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`, and point `api_key_env` at it — noting the [disclaimer](../../docs/anthropic.md#claude-subscription-auth). The embedded CLI draws on the subscription natively either way, which is the officially supported path.

## The blast area

For `agent.yaml`: `net: [api.github.com]` is the whole capability surface, enforced by the runtime, not just the permission engine. No shell, no files, no other host. What remains is the token — whatever it can reach, the agent can reach — and the `from_users` list plus `TTY_TOKEN`, which are who gets to ask. Those three are the controls that matter. The skill tells the agent to confirm before merges, closes, deletes and marking notifications read, and to never bulk-mutate; that is a good default, not an enforced one, which is why the token's scopes are the real boundary.

For `agent.cli.yaml`, add: `gh` and `claude` can reach the whole internet from inside the container, and `claude -p --dangerously-skip-permissions` is a full agent with a checkout. The container is the wall there. Run it on a host you're happy to have a coding agent loose in.
