# Plan 10 — Slash commands

Operating a deployed agent happens from the outside today: query the status server, read `docker logs`, edit the config and restart. From inside the channel where the agent actually lives, the only thing you can do is talk to the model, which means even "what model are you running?" costs a provider call and gets a model-shaped answer. Small operator actions deserve a deterministic path, and the chat surfaces already have a convention for one: a message that starts with a slash.

Status: implemented, including native registration (phase 3) — Discord application commands with interaction handling, Telegram `setMyCommands`, and Slack `slash_commands` envelopes over Socket Mode. See [docs/slash-commands.md](../docs/slash-commands.md).

## One interception point covers every channel

Every trigger routes through the single choke point `AgentService.handle()`, so command handling lives there: at the top of `handle()`, before the session loads and before any provider call. A recognized command runs its handler, produces a synthetic `RunResult` (zero steps, zero tokens) and rides the normal reply path back through whichever trigger delivered it. That one placement makes commands work on Discord, Slack, Telegram, the REPL and the email trigger (Plan 7) with no per-trigger code, and each command execution lands in the audit trail with its own kind.

Parsing is strict on purpose: a leading `/` followed by an exact known command name. Everything else falls through to the model untouched, so a pasted file path or a `/shrug` meant conversationally never gets eaten. The parser is a pure function with its own test file, like the trigger filters.

## Built-ins

- **`/help`** lists the available commands, including the config-defined ones with their descriptions.
- **`/status`** answers with the facts the status server already knows: identity, model, uptime, recent run count and token totals. The same information, delivered where the operator already is.
- **`/reset`** clears the conversation history for the thread it was typed in, scoped to that event's `conversationKey`, so resetting a Discord channel touches nothing else. This needs the store's first session-clearing method (`messages` delete by session id); persistent memories are untouched, since forgetting facts already has its own tools.

## Config-defined commands

The second half is operator-authored shortcuts:

```yaml
commands:
  - name: standup
    description: Summarize the last day of activity
    prompt: |
      Summarize what happened in the last 24 hours for the team standup.
      Focus: $ARGS
```

`/standup deploys` substitutes the arguments and runs the normal loop with that prompt as the input. This gives operators a deliberate, repeatable way to invoke behaviour that today requires typing the same paragraph into the channel, and it composes with skills: a command's prompt can direct the agent to read a specific skill first, which makes commands the user-facing invocation layer that `read_skill` currently lacks.

## Who gets to run them

A command is admitted by the same filters as any other message: `from_users` on the chat triggers, `from_addresses` on email. Within that audience there is no further gate in v1, which is fine for `/help` and `/status` and worth naming for `/reset`: anyone the trigger admits can wipe the thread's history. The blast radius is one conversation's context, the persistent memories survive, and the audit trail records who did it. If a deployment needs tighter control, a per-command `operators:` allowlist is the natural extension point, listed as an open question rather than built speculatively.

## Native command registration comes later

Discord application commands, Telegram's `setMyCommands` and Slack's slash commands would give autocomplete and discoverability in each client. They are also three separate registration APIs, and Slack's version wants a public request URL, which fights the Socket Mode design that keeps Slack agents deployable without ingress. Plain-text parsing needs none of that and works identically everywhere, so native registration is a later, cosmetic layer on top of the same parser. The one behavioural note: in clients with a native slash UI, typing `/status` may pop the client's own picker, and the message still arrives as plain text for the agent to handle.

## Phasing

1. **Parser, built-ins, the store reset method.** `/help`, `/status`, `/reset`, audit entries, tests for the parser and the session clear.
2. **Config-defined commands.** Schema (`commands:` with name, description, prompt), `$ARGS` substitution, `/help` integration.
3. **Native registration.** Per-platform command registration for autocomplete, behind the same handlers.

## Open questions

- Does `/reset` warrant a per-command `operators:` allowlist from day one, or is trigger-level filtering plus the audit trail enough until someone asks?
- Should the webhook and a2a triggers honor commands too, or are commands a chat-surface feature? A machine caller sending `/status` is probably better served by the status endpoints.
- More built-ins suggest themselves (`/skills` to list loaded skills, `/memory` to list persistent memories); which earn a place before config-defined commands cover them?
- Should a config-defined command be able to force a model role or a step limit (a cheap `/summary` pinned to `model.small`)?
