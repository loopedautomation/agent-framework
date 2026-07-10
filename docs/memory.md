---
title: "Memory"
description: "Two independent kinds of memory: thread history that replays a conversation, and persistent memory that survives across conversations and restarts."
---

The `memory:` block controls two independent things: whether a conversation's history replays on the next message in that thread, and whether the agent can save facts that outlive any single conversation.

```yaml
memory:
  scope: thread             # default: none
  persistent: true          # default: false
  compact_at_tokens: 50000  # default: 50000; false disables
```

Both default off. An agent with no `memory:` block starts every run with a blank slate — no history, no remembered facts — which is the right choice for a stateless webhook handler that shouldn't accumulate anything between calls.

## Thread history: `scope`

`scope: thread` persists the message transcript per *conversation key* — the chat channel or thread (Discord, Slack, Telegram), the webhook caller's `conversation_id`, or the REPL session. On the next event in the same conversation, the full prior transcript loads back in, so follow-ups work ("make it weekly instead" refers to what was just discussed). `scope: none` (the default) starts every run fresh, even within what a human would call the same conversation.

This is the entire transcript, replayed verbatim — expensive in context, but complete. It answers "what did we just say to each other," not "what do you know about me."

## Compaction

A thread that never ends has a cost that never stops growing. Every run replays the full transcript, so each message in a long-lived conversation costs a little more than the last, and eventually the transcript outgrows the model's context window entirely. Compaction is the pressure valve: the agent asks a model to write a summary of the older turns, and the transcript becomes that summary plus the most recent two turns kept verbatim. The summary is written by `model.small` when you've set one, which is exactly the kind of cheap internal call that role exists for.

You can trigger it by hand with [`/compact`](slash-commands.md), and the agent runs it on its own once a conversation crosses `compact_at_tokens`:

```yaml
memory:
  scope: thread
  compact_at_tokens: 50000
```

The threshold is the input token count the provider reported for the run's last model call, which is to say the real size the conversation's context has reached. The check happens after a run finishes, so the reply that crossed the line still goes out normally and the summarizing happens before the next message in that conversation loads its history. The default is 50000 tokens; set `false` to turn auto-compaction off, and set it lower if you're running a model with a small context window. Without `scope: thread` there is no history, so the setting does nothing.

Compaction spends a model call, and the spend stays visible: each auto-compaction is recorded as its own run with `compaction` as the trigger, and it shows up in `/status` totals and the runs table like any other call. If the summarize call fails, the transcript stays exactly as it was and the failure lands in the [audit trail](docker-run.md#persistence-the-data-volume).

Be aware of what you're trading. A summary is lossy: the exact wording of older turns is gone from the agent's working memory once they're folded in, and only the last two exchanges survive verbatim. Facts that must outlive any transcript belong in persistent memory, which compaction never touches.

### `/new` and `/reset`: starting over

Compaction keeps a conversation going; the other two history commands end it. `/reset` deletes the thread's transcript outright. `/new` retires the current thread and starts a fresh one under the same channel or thread key, with the old transcript archived in the agent's SQLite file, so the history is still there if you ever need to look back at it in the [data volume](docker-run.md#persistence-the-data-volume).

## Persistent memory: `persistent`

`persistent: true` gives the agent four tools, backed by its own SQLite file:

| Tool | Effect |
| --- | --- |
| `remember` | Save or update a fact under a key. Overwrites any existing value for that key. |
| `recall` | Read one fact back by key. |
| `list_memories` | List every key and value currently held. |
| `forget` | Delete a fact by key. |

Unlike thread history, these facts are keyed by nothing but the agent itself — they're visible from *every* conversation key, and they survive a run that starts with `scope: none`. This is where an agent puts a user's stated preference ("always deploy to us-east"), a fact it was told once and shouldn't need repeating ("the on-call rotation is in #incidents"), or a note to its future self about long-running work ("waiting on PR #204 to merge before continuing the migration"). Thread history can't do this: it's scoped to one conversation key, and it's a full transcript rather than a distilled fact.

The agent decides what's worth remembering — there's no automatic extraction from the conversation. A `purpose` that expects the agent to retain user preferences should say so explicitly, the same way it would spell out any other expected behavior.

### What the model sees

Reading every remembered fact into every system prompt would burn context as memories accumulate, so persistent memory follows the same progressive-disclosure shape as [skills](skills.md#progressive-disclosure): the system prompt carries only the *keys* currently held —

```
You have persistent memory — facts and preferences that survive across
conversations and restarts. Use recall to read one, list_memories to browse,
remember to save or update one, forget to delete one. Keys you already have:
- deploy_region
- oncall_channel
```

— and the agent spends a `recall` or `list_memories` call to pull the value into context only when a turn actually needs it. An agent with fifty memories costs fifty short lines until it reads one.

### Where it lives, and its boundaries

Memories live in the `memories` table of the agent's own SQLite file, alongside sessions, runs, audit and identity — the same file described in [Persistence: the data volume](docker-run.md#persistence-the-data-volume). This keeps memory agent-local, consistent with one agent doing one job: there is no mechanism for one agent to read another's memories, and a fresh data volume clears memory exactly the way it clears identity and history.

Every `remember` and `forget` call lands in the [audit trail](docker-run.md#persistence-the-data-volume) as a `memory` event (`{ action: "remember" | "forget", key }`), visible at `GET /audit` alongside permission decisions. `recall` and `list_memories` are read-only and aren't audited, the same way an allowed `read_file` isn't.

## Combining both

`scope` and `persistent` compose freely — they answer different questions:

```yaml
memory:
  scope: thread       # replay this conversation's transcript
  persistent: true    # and carry facts across every conversation
```

A support-bot agent might run `scope: thread` alone (each ticket thread needs its own context, nothing more), while a personal-assistant agent typically wants both: thread history for the back-and-forth of the current request, persistent memory for "she prefers window seats" to still be true next month, in a different channel.
