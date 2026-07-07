# Plan 12 — Channels: triggers were always two-way

The `triggers:` key has been mislabeled since the day the reply path was folded into it. A trigger in this framework connects outward, receives a message, waits for the run and then delivers the reply back over its own connection; the Discord implementation even takes a `reply_channel` option that sends the answer somewhere other than where the question came from. These things receive and send. They are communication channels, and the config key should say so.

The rename also unlocks the feature the old name was hiding. Because a "trigger" owns both directions, an agent's output can only go where its input came from, so a webhook-fed agent can never post its result to Slack, and cron is the standing embarrassment: `cron.ts` carries the comment "cron has no reply channel; default logs" and prints the agent's work to the console. Once the things in config are channels with names, "receive here, deliver there" becomes one field.

Status: design; implementation has not started. This plan renames a load-bearing config key, so it also covers the migration.

## The model

A channel is a named connection to a place where messages move in either direction. Some channels listen and produce events, some can deliver a message, most do both. The event that wakes the agent is still called a trigger; the channel is the pipe it arrives through.

```yaml
channels:
  - name: intake
    type: webhook
    path: /report
    reply_to: team

  - name: team
    type: slack
    channel: "#reports"

  - name: nightly
    type: cron
    schedule: "0 6 * * *"
    prompt: Summarize yesterday's activity.
    reply_to: team
```

Each entry is the existing discriminated union plus two fields: a `name` (defaulting to the type when there is only one of that type) and an optional `reply_to` naming the channel that should deliver the run's reply. Without `reply_to` the reply goes back where the event came from, which is exactly today's behaviour, so every current config maps 1:1. With it, the webhook above answers its HTTP caller and the substantive result lands in Slack, and the nightly cron finally has somewhere to put a morning summary.

Sessions stay keyed by the source: `conversationKey` comes from the channel that produced the event, so routing the output elsewhere touches delivery and nothing about memory.

## Not every channel can do both jobs

Direction is a per-type capability, and `af validate` enforces the matrix rather than letting a config fail at 6am:

- **cron** listens only. A `reply_to` pointing at cron is a config error.
- **webhook** listens, and its only "send" is the synchronous HTTP response to the caller. Using a webhook channel as another channel's `reply_to` is a config error until a callback-URL story exists (open question).
- **discord, slack, telegram, email** (Plan 7) do both. Used as a delivery target, each needs a default destination in its own config (the Slack entry's `channel:`, an email channel's `to:`), which is the existing `reply_channel` idea generalized.
- **a2a** (Plan 8) listens and answers its caller synchronously, like webhook.

Delivery to a routed channel reuses the machinery the chat channels already have: `splitMessage`, threading behaviour and `NO_REPLY` handling live with the channel that does the sending.

## What gets renamed

The word runs deep, so the rename is listed exhaustively rather than discovered in review:

- **Config**: `channels:` becomes the documented key. `triggers:` keeps working as an alias for a deprecation window, mapped 1:1 with a startup warning naming the new key; the JSON Schema marks it deprecated. We are pre-1.0, so the alias is a courtesy with a stated removal version rather than a permanent burden.
- **Interfaces**: `Trigger` becomes `Channel`, `triggersFromConfig` becomes `channelsFromConfig`, and `AgentEvent.trigger` becomes `AgentEvent.channel`, with deprecated re-exports for one release.
- **The package**: `@looped/triggers` publishes as `@looped/channels`; the old JSR name gets a final version that re-exports and points here.
- **The store**: `runs.trigger` becomes `runs.channel` via migration 002, the first real use of the migration runner. The `/runs` status payload changes field name with it.
- **Docs**: the `---Triggers---` group in `docs/meta.json` becomes Channels, each page moves terminology, and `docs/agent-file.md` follows. The docs-site sync carries it to docs.looped.sh.
- **Plans**: Plan 1's "Triggers" concept section, and the trigger language in Plans 7 and 8, get amended in place when this ships, per the series rules. The differentiator claim survives the rename intact; channels-in-config is a stronger version of it.

## Channels as tools, later

Once channels have names, the model itself can be given a send: a channel with `as_tool: true` exposes a `send__<name>` tool, so an observer agent can post a notice mid-run without ending its work, and a multi-channel agent can decide at run time where a message belongs. That is deliberately phase 3: it changes the toolset surface and the audit story (every send is an audit row), and the declarative `reply_to` covers the common cases without giving the model new capability. Opt-in per channel, since a tool the agent can't use shouldn't exist.

## Phasing

1. **The key and the rename.** `channels:` with `name`, the `triggers:` alias and warning, the interface and package renames, migration 002, schema regen, the docs and examples sweep, plan amendments.
2. **Routing.** `reply_to`, per-type delivery defaults, the validate-time capability matrix, cron's output finally landing somewhere.
3. **Sends as tools.** `as_tool: true`, the `send__<name>` tools, audit entries per send.

## Open questions

- Does `reply_to` accept a list for fan-out delivery, or one destination until someone needs two?
- A webhook callback mode (accept, return 202, POST the result to a configured URL) would make webhook a full two-way channel; is that this plan or the webhook page's own future?
- Should the `triggers:` alias survive to 1.0, or is one minor-version window enough at this stage of adoption?
- `runs.channel` vs keeping the old column name and mapping in code: the migration is one ALTER TABLE, but does anything downstream (dashboards, the platform's aggregation in Plan 5) read the column name today?
- When a routed delivery fails (Slack is down) but the run succeeded, what does the source channel hear, and does the run status reflect it?
