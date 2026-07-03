# Skills, MCP, and the Discord trigger

Status: covers M3.

## Skills — teach any CLI or API

A skill is a markdown file that teaches the agent how to use something well. Skills carry **knowledge, never capability**: a skill can't grant permissions — the config's `permissions:` block stays the sole authority, so the worst a bad skill can be is misleading documentation.

```yaml
skills:
  - ./skills/gh-issues.md
permissions:
  run: [gh]        # the capability half of the recipe
```

Skill files take optional YAML frontmatter (`name`, `description`); otherwise the filename and first line stand in:

```markdown
---
name: gh-issues
description: Create and manage GitHub issues with the gh CLI.
---

# Managing GitHub issues with `gh`
...full instructions...
```

**Progressive disclosure** keeps this cheap-model friendly: the system prompt carries one line per skill; the agent reads the full document with the `read_skill` tool only when the task calls for it. See [`skills/gh-issues.md`](../skills/gh-issues.md) for the first-party example.

The default recipe for integrating anything: **custom image provides the binary, skill provides the knowledge, permissions provide the safety.**

## MCP servers

For when a good MCP server exists and is worth the context cost:

```yaml
tools:
  mcp:
    - name: github
      command: ["docker", "run", "-i", "ghcr.io/github/github-mcp-server"]  # stdio
      env:
        GITHUB_TOKEN: ${GITHUB_TOKEN}     # scoped: the server sees only this
      include: [create_issue, update_issue, search_issues]
    - name: internal
      url: https://mcp.internal.example.com/mcp                             # or HTTP
```

- Tools are namespaced `mcp__github__create_issue` in the loop and the audit trail.
- **`include:` is strongly recommended** — a 40-tool server is 40 schemas in a small model's context; expose the three you need.
- Results are truncated at 8k chars; servers connect at startup and close on shutdown.

## Discord trigger

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
4. OAuth2 → URL Generator: scope `bot`, permissions *View Channels*, *Send Messages*, *Read Message History* → open the URL, invite the bot to your server.
5. `deno task af run agent.yaml`

The agent replies in-channel to the triggering message; conversations are keyed per channel/thread (`memory.scope: thread` continues them). It ignores bots, itself, and empty messages; long replies split at Discord's 2000-char limit.

### Observer agents

The three optional keys together turn the trigger from a chatbot into an observer — an agent that watches channels, reacts to specific people, and reports elsewhere (a review bot, a moderation assistant, a coach):

- `from_users` — handle only these authors. The filter runs *before* the model is called: everyone else's messages are dropped in the trigger and never reach the provider.
- `reply_channel` — deliver replies to a dedicated channel instead of the source. Out-of-channel replies quote the triggering message and link back to it.
- `allow_silence` — let the agent say nothing. Instruct it in `system_prompt` to answer with exactly `__NO_REPLY__` when it has no feedback; the trigger then posts nothing instead of a "looks fine" reply on every message.

## First boot: the naming ritual

The first time an agent runs, it chooses its own name — one LLM call (routed to the cheap `model.small` role), persisted for life in its SQLite identity. The CLI marks the occasion with the birth banner. You address the agent by its config `nickname`; it signs its work with the name it chose. A fresh data volume means a new self — the agent renames itself.
