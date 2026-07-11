---
title: "Slash commands"
description: "Built-in and operator-defined commands that run deterministically, with no model call, on every chat surface and in the REPL."
---

Operating a deployed agent usually means going around it: query the status server, read `docker logs`, edit the config and restart. From inside the channel where the agent lives, the only thing you can do is talk to the model, so even "what model are you running?" costs a provider call and gets back a model-shaped answer. Small operator actions deserve a deterministic path, and chat surfaces already have a convention for one: a message that starts with a slash.

A recognized command is intercepted before the session loads and before any provider call. It runs its handler and rides the normal reply path back through whichever trigger delivered it. This means commands work the same on Discord, Slack, Telegram, the webhook trigger and the REPL, with no per-surface behavior to learn. Almost every built-in answers deterministically with zero steps and zero tokens; the one exception is `/compact`, which spends a single model call to write the summary it replaces the history with.

Parsing is strict on purpose. The message has to be a `/` followed by an exact known command name; everything else falls through to the model untouched, so a pasted file path or a conversational `/shrug` never gets eaten.

## Built-ins

Every agent answers six commands with no configuration:

| Command | What it does |
| --- | --- |
| `/help` | List the commands this agent responds to, including your config-defined ones with their descriptions. |
| `/status` | Report the agent's identity, model, uptime, and run totals. The same facts the [status server](docker-run.md) exposes, delivered where you already are. |
| `/reset` | Clear the conversation history for the thread it was typed in. Persistent memories survive. |
| `/compact` | Summarize the conversation and replace its history with the summary plus the most recent turns. The one built-in that costs a model call. See [Memory](memory.md#compaction). |
| `/new` | Start a fresh conversation under the same channel or thread. The old history stays archived in the agent's data volume. |
| `/stop` | Stop the run currently in progress in this conversation. If nothing is running, it says so. |

`/reset`, `/compact` and `/new` are scoped to one conversation key, so running them in a Discord channel touches nothing else. They only apply when [`memory.scope: thread`](memory.md) is on; an agent that keeps no history says so and does nothing. The difference between the three is what happens to the transcript: `/reset` deletes it, `/compact` shrinks it and keeps the conversation going, and `/new` retires it and starts over.

`/stop` is the one command that skips the conversation's queue. Messages in a conversation normally run one at a time in arrival order, so a queued `/stop` would wait behind the very run it is meant to stop. Instead it is handled the moment it arrives: it fires an abort signal at the run in flight and replies right away, and the stopped run sends its own reply once it halts. The stop is cooperative. A provider call or tool that is already underway runs to completion, and the run ends at the next step boundary, so a long tool call can hold the stop up for as long as it takes to return. The partial transcript stays in the conversation's history, and events already waiting in the queue still run when their turn comes.

## Config-defined commands

The second half is your own shortcuts:

```yaml
commands:
  - name: standup
    description: Summarize the last day of activity
    prompt: |
      Summarize what happened in the last 24 hours for the team standup.
      Focus: $ARGS
```

`/standup deploys` substitutes `deploys` for `$ARGS` and runs the normal agent loop with that prompt as the input. This gives you a repeatable way to invoke behavior that would otherwise mean typing the same paragraph into the channel each time. It also composes with [skills](skills.md): a command's prompt can direct the agent to read a specific skill first, which makes commands the invocation layer that `read_skill` lacks on its own.

Command names are lowercase letters, digits and underscores, at most 32 characters. That's the strictest platform rule, so one name registers everywhere. Descriptions are capped at 100 characters for the same reason; they appear in `/help` and in each platform's native command picker. The built-in names are reserved, and the config loader rejects a command that tries to redefine one.

## What the platforms show

Each chat platform gets the native treatment its API allows, so commands show up with autocomplete and descriptions where the client supports it:

- **Discord**: the trigger registers your command list as application commands at startup, so typing `/` pops Discord's own picker with descriptions. Picking one arrives as an interaction; the agent acknowledges it with Discord's "thinking…" state and fills in the reply when the run finishes. Typing the command as plain text works too.
- **Telegram**: the trigger calls `setMyCommands` at startup, so the `/` menu lists your commands with descriptions. Telegram addresses commands per-bot in groups (`/status@your_bot`); the trigger strips the suffix before parsing.
- **Slack**: Slack treats any message starting with `/` as a slash command and never delivers it as a message, so plain-text parsing can't work there. Add the commands to your Slack app configuration (they work over Socket Mode, no public URL needed) and the trigger handles the rest, replying through the command's response URL.
- **REPL**: the interactive REPL that `af run` opens for trigger-less agents shows a dropdown of every command with its description as you type `/`. Two screen-only commands join the list there: `/clear` and `/exit`.
- **Webhook**: plain text, no registration. POST `/status` as the input.

Registration is cosmetic: the plain-text parser is the real path, and a failed registration only logs a warning.

## Who gets to run them

A command is admitted by the same filters as any other message: `from_users` on the chat triggers. Within that audience there is no further gate, which is fine for `/help` and `/status` and worth naming for the history commands: anyone the trigger admits can wipe a thread's history with `/reset`, rewrite it with `/compact` or rotate it with `/new`. The blast area is one conversation's context, persistent memories survive, and every command execution lands in the [audit trail](docker-run.md) as a `command` event recording who ran what.

## What this doesn't do

Commands can't grant capability. A config-defined command is a prompt template; it runs the same loop under the same [permissions](permissions.md) as any other message, so `/deploy` can't do anything the agent couldn't already do when asked in prose. There is also no per-command allowlist yet; if a deployment needs `/reset` locked down tighter than the trigger's `from_users` filter, that's an open question in [plan 10](https://github.com/loopedautomation/agent-framework/blob/main/plans/010-slash-commands.md).
