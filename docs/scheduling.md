---
title: "Scheduling"
description: "The agent files future work for itself: reminders and recurring runs it creates in conversation, persisted in SQLite and delivered back to the chat that asked."
---

"Remind me on Thursday" is an ordinary thing to say to an assistant, and until now the framework had no way to honor it. A [cron trigger](cron.mdx) runs on a schedule you wrote into the config at deploy time; the agent itself could only ever react to events, so a promise about the future was a promise it couldn't keep.

The `schedules:` block gives the agent that ability:

```yaml
schedules:
  max: 20   # default: 20 schedules held at once
```

With the block present, the agent carries three tools. `schedule` files a future run: a five-field cron expression (with an optional IANA `timezone`) for recurring work, or an ISO timestamp for a one-shot like a reminder. `list_schedules` shows everything currently held, and `unschedule` cancels by id. What the agent actually schedules is a prompt addressed to its future self, so "remind me about the dentist on Thursday" becomes a stored prompt along the lines of "Reminder for Ratul: dentist appointment today" with a timestamp attached.

Schedules live in a `schedules` table in the agent's own SQLite file, next to sessions and memories, so a container restart changes nothing. A one-shot that came due while the agent was down fires as soon as it starts again; for a reminder, late beats never. One-shots retire after their run completes, which means a crash mid-run replays the reminder on restart instead of losing it. You might very occasionally get a reminder twice, and we chose that over the alternative.

## The result comes back to you

A schedule remembers the conversation it was created in. When it fires, the prompt runs through the normal event path, under the same lanes, [limits](agent-file.md#limits) and [permissions](permissions.md) as any message, and the reply is delivered to that conversation: the Discord channel or DM, the Telegram chat, the Slack thread. This is the first place the framework sends a message without an incoming message to answer, and it only does so on the schedule the agent was told to keep.

A schedule created somewhere with no deliverable conversation (a one-shot `af run`, a keyless webhook call) still runs; its result lands in the container log and the [runs table](docker-run.md#persistence-the-data-volume), the same place config cron results go.

## Bounds

Unattended future work needs the same dead-man's switches as everything else:

- `max` caps how many schedules exist at once (default 20). Past the cap the tool refuses and tells the model to `unschedule` something first.
- The finest granularity is one minute; second-level cron patterns are refused.
- Every firing is an ordinary run, so `limits.max_steps` caps what it can spend, and a recurring schedule can never overlap itself; agent-created schedules get the same no-overlap treatment as a [cron trigger](cron.mdx).
- Creating and cancelling are audit rows (`kind: "schedule"`), and every firing is a run with `schedule` as its trigger, so the [audit trail](docker-run.md) shows who asked for what and what it cost.

## What this is for, and what it isn't

Reminders, digests an operator asked for in chat, a follow-up the agent promised ("I'll check the deploy again in an hour"): anything where the agent commits to future work in conversation. For a schedule that is part of the agent's job description, keep using a [cron trigger](cron.mdx) in the config: it's reviewable, versioned and survives a wiped data volume, which agent-created schedules do not.
