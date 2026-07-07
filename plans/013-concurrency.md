# Plan 13 — Concurrency: one agent, many conversations

Send an agent ten instructions, one Discord message at a time, while each run takes a couple of minutes. Or have two teammates ask it for two different things at once. Both are ordinary uses of a deployed agent, and the framework currently has no position on either; what happens is an accident of each trigger's transport. Telegram processes one update at a time because its poll loop awaits the run before fetching more. Discord starts a run for every message the gateway delivers, with no bound. The webhook trigger starts a run per HTTP request. Cron can fire while its previous run is still going, because we set no overrun protection on the schedule. One agent, four different concurrency behaviours, none of them chosen.

The unchosen behaviour also hides a real bug. `saveMessages` persists a session by deleting its rows and rewriting the full transcript. Two runs on the same `conversationKey` at once both load the same history, run independently and rewrite the session on completion, so the last writer erases the other run's messages. The ten-instructions scenario on Discord does this today: later messages race earlier ones, each run is blind to what the previous one did, and the session history ends up missing runs. This plan decides the concurrency model on purpose and fixes that along the way.

Status: phase 1 (correctness) implemented — the per-conversation FIFO, `limits.concurrent_runs`, `limits.queue_depth` with the refusal reply, cron overrun protection via a serial lane, `busy_timeout`, and Telegram's poll loop dispatching without awaiting so the service owns ordering. Phases 2 and 3 have not started.

## The model: conversations are the unit of order

Two rules, both enforced at the single choke point every trigger already routes through, `AgentService.handle()`:

1. **Within a conversation, runs are serial and ordered.** Events with the same `conversationKey` join a FIFO queue and run one at a time, in arrival order. Each run loads history after its predecessor persisted, so message four's run sees what messages one through three did. This is what makes the ten-instructions case work the way the sender assumes it works, and it makes the history race impossible without touching the store's write pattern.
2. **Across conversations, runs are parallel up to a cap.** Different `conversationKey`s have no ordering relationship, so they run concurrently through a semaphore: `limits.concurrent_runs`, default 4. A run is almost entirely awaiting the provider and tools, so the process handles parallel runs cheaply, and the default means one person's long task no longer makes the agent look dead to everyone else. Setting it to 1 gives strict whole-agent serialization for operators who want today's Telegram behaviour everywhere.

Two people in the same Discord channel share a `conversationKey`, so their requests serialize, which is right: they share the conversation's context, and interleaved replies in one channel would be noise. Two people in two channels run in parallel. The queue and the semaphore are in-process and live in the service, so every trigger inherits the same behaviour with no per-trigger code, the same argument that placed slash commands (Plan 10) at `handle()`.

Events with no `conversationKey` have no ordering constraint and take a semaphore slot directly. Cron gets one specific promise: a schedule never overlaps itself. At most one firing runs and at most one waits; further firings while both slots are full are skipped with an audit entry, since running a 6am summary three times at 6:07 helps nobody.

## Bounds, because a queue is a place work goes to hide

Every queue in the framework's philosophy needs a dead-man's switch, and this one gets two:

- **Depth.** A conversation's queue holds `limits.queue_depth` events (default 10). Past that, the event is rejected and the trigger delivers a short built-in refusal through the normal reply path, so the sender learns immediately instead of discovering an hour later that message eleven evaporated. Every rejection is an audit row.
- **Visibility.** A queued event is not silent: chat triggers keep their existing acknowledgement behaviour going (Discord's typing indicator already loops during runs and extends naturally to waiting), and `/status` (Plan 10) grows a line for runs in flight and queued events. A `/cancel` built-in that clears the current conversation's queue, and eventually aborts the in-flight run via an `AbortController` threaded through `runAgent`, is the steering mechanism, phased below.

The queue is in-memory, and we say so honestly: a container restart drops queued events. Telegram acknowledges a batch on its next poll, so on restart it redelivers only updates it had not yet handed over; Discord and webhooks do not redeliver at all. The runs table records everything that started, so what was lost is knowable. Whether queued events deserve a durable inbox table in SQLite is an open question rather than v1 scope, because it drags in dedup keys and replay semantics that the single-box deployment mostly does not need.

## Scaling a single agent

The question "how do we scale this agent up" has three answers in order:

1. **Raise the cap.** Runs are IO-bound; one process on one small container sustains dozens of concurrent runs before anything local strains. The likely first limit is the model provider's rate limit, which arrives as classified provider errors the loop already retries.
2. **Split the job.** An agent saturated with work is usually two jobs wearing one nickname, and the framework's answer is fission: another agent file, another container, with Plan 8's composition when they need each other. One agent, one job scales by becoming two agents with two jobs.
3. **Replicas are rejected for now.** Running two containers of the same agent breaks in three places at once: a second Discord gateway connection means every message is handled twice, the SQLite volume has one writer, and thread sessions would need sticky routing. Making replicas real means external event dedup, a shared store and a load balancer that understands conversations, which is platform infrastructure (Plan 5), where the hosted network can own it. A self-hosted webhook-only agent behind a load balancer with separate data volumes works today for stateless jobs, and that narrow recipe can be documented, but the framework does not pretend to a horizontal story it does not have.

## Store hardening under parallelism

WAL mode is already on. Cross-conversation parallel runs add concurrent writers to one SQLite file, so the store gains a `busy_timeout` and the write paths keep transactions short, which they already are. The full-replace `saveMessages` stays as is: per-conversation serialization is what makes it safe, and replacing it with append-only writes would be optimizing a race that no longer exists.

## Phasing

1. **Correctness.** The per-conversation FIFO, the semaphore with `limits.concurrent_runs`, `limits.queue_depth` with the refusal reply, cron overrun protection, `busy_timeout`. This phase deletes the history race.
2. **Visibility and steering.** Queue and in-flight counts in `/status`, queued-state acknowledgement per chat trigger, `/cancel` clearing the conversation's queue.
3. **Run abort.** `AbortController` through `runAgent` and the tool layer so `/cancel` can stop the in-flight run too, with the partial transcript persisted and the run recorded as cancelled.

## Open questions

- Is 4 the right default for `concurrent_runs`, or should the default stay 1 and make parallelism the explicit choice? Default-1 is more predictable; default-4 matches how people actually share an agent. Someone should hold the opinion after phase 1 ships and the examples get used.
- Should closely spaced messages in one conversation coalesce into a single run (the ten instructions arriving as one combined input), or stay one-run-per-message? Coalescing is cheaper and reads more like how a human catches up on a channel, but it blurs the one-reply-per-message contract.
- Does the queued-event refusal deserve configurability (silent drop for noisy webhook sources), or is refusing always right?
- The durable inbox: does any real deployment lose enough queued work in restarts to justify dedup keys and replay semantics in the framework, or does at-least-once via the platform stay the answer?
- When `/cancel` aborts a run mid-tool-call, what does the tool see? Killing a `run_bash` subprocess is clean; abandoning an MCP call mid-flight may leave the server confused.
