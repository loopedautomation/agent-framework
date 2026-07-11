---
title: "Scheduling"
description: "The schedules block lets the agent file future runs of itself: reminders and recurring work it takes on in conversation, kept in SQLite and delivered back to the chat that asked."
---

"Remind me on Thursday" is an ordinary thing to ask an assistant, but look at what it needs from the framework. Triggers fire when something arrives from outside, and a [cron trigger](cron.mdx) follows a schedule you write into the config before the agent starts. A reminder fits neither shape: it's a commitment the agent takes on in the middle of a conversation, at a time nobody knew when the config was written. The `schedules:` block is how the agent keeps that kind of commitment:

```yaml
schedules:
  max: 20   # default: 20 schedules held at once
```

With the block present, the agent carries three tools. `schedule` files a future run: a five-field cron expression (with an optional IANA `timezone`) for recurring work, or an ISO timestamp for a one-shot like a reminder. `list_schedules` shows everything currently held, and `unschedule` cancels by id. What the agent actually stores is a prompt addressed to its future self, so "remind me about the dentist on Thursday" becomes something along the lines of "Reminder for Ratul: dentist appointment today", attached to a timestamp.

Schedules live in a `schedules` table in the agent's own SQLite file, next to its sessions and memories, so a container restart loses nothing. A one-shot that came due while the agent was down fires as soon as it starts again, because a late reminder is more useful than a lost one. One-shots retire after their run completes rather than before it starts, which means a crash in the middle of a run replays the reminder on restart. Once in a while that can hand you the same reminder twice; we chose that over ever dropping one silently.

## The result comes back to you

A schedule remembers the conversation it was created in. When it fires, the stored prompt runs through the normal event path, under the same ordering, [limits](agent-file.md#limits) and [permissions](permissions.md) as any message, and the reply is delivered to that conversation: the Discord channel or DM, the Telegram chat, the Slack thread. The agent writes into a chat for two reasons: to reply to a message, or to keep a schedule someone asked it for.

A schedule created somewhere with no deliverable conversation (a one-shot `af run`, a keyless webhook call) still runs; its result lands in the container log and the [runs table](docker-run.md#persistence-the-data-volume), the same place config cron results go.

## Bounds

An agent that can promise future work needs a limit on how much it can promise, because every schedule is a model call that will spend money with nobody watching:

- `max` caps how many schedules exist at once (default 20). Past the cap the tool refuses and tells the model to `unschedule` something first.
- The finest granularity is one minute; second-level cron patterns are refused.
- Every firing is an ordinary run, so `limits.max_steps` caps what it can spend, and a recurring schedule can never overlap itself; agent-created schedules get the same no-overlap treatment as a [cron trigger](cron.mdx).
- Creating and cancelling are audit rows (`kind: "schedule"`), and every firing is a run with `schedule` as its trigger, so the [audit trail](docker-run.md) shows who asked for what and what it cost.

## A job belongs in the config

Schedules suit commitments made in conversation: a reminder, a digest someone asked for in chat, a follow-up the agent promised ("I'll check the deploy again in an hour"). When a schedule is part of the agent's job description, write it as a [cron trigger](cron.mdx) in the config instead. The config gets reviewed like code and survives a wiped data volume; agent-created schedules live in that volume and go with it.
