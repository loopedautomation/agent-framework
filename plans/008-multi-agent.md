# Plan 8 — Multi-agent: composition and A2A

One agent, one job is the first principle, and it eventually produces the obvious next question: what happens when a job is really two jobs? Plan 1 answered with a posture, composition over orchestration, an agent exposed as a tool to another agent, and left the rest as a sketch with no v1 commitment. This plan is the design that sketch was waiting for.

Status: design; implementation has not started. Both halves ("multi-agent composition (`agent_call`) and A2A trigger") sit on the roadmap's later list (Plan 3).

## The posture, restated

Composition means the calling agent's model decides when to hand work to another agent, the same way it decides when to run a tool. There is no pipeline in config, no planner, no shared scratchpad. Each agent keeps its own permission block, its own limits, its own memory and its own audit trail; handing a task to a colleague never widens what either of them may do. A fleet stays legible because every member is still one file with one job.

## One protocol serves both directions

Two features are waiting on the same missing primitive. `agent_call` needs a way for one container to send a message to another and get a reply. The A2A trigger needs an endpoint where the outside ecosystem can do the same thing. Both are "an HTTP surface that accepts a message and returns a result", so we build it once and speak A2A on it.

A2A (Agent2Agent, now a Linux Foundation project) gives the shape: an agent card describing identity and skills at a well-known path, a message-send method, task states, streaming later. Adopting it means a Looped agent calling a Looped agent uses the same wire format as an outside agent calling into the fleet, and the framework gets ecosystem reachability as a side effect of building its own composition primitive.

The webhook trigger stays what it is: a plain POST for humans and scripts. A2A is the agent-shaped door.

## The callee: an `a2a` trigger

```yaml
triggers:
  - type: a2a
    port: 8790
    token_env: A2A_TOKEN
```

The trigger serves the agent card and the message endpoint, checks a bearer token with the same timing-safe compare the webhook trigger uses, and turns an incoming message into an ordinary `AgentEvent` with `conversationKey: a2a:<context id>`, so a multi-turn exchange threads through session memory like any Discord channel does. Replies are synchronous in v1, the webhook trigger's model; streaming task updates come later.

The agent card is generated from the config: the description, the trigger surface and one card skill per configured skill, straight from the descriptions already written for progressive disclosure. Nothing is authored twice.

## The caller: agents declared as tools

```yaml
tools:
  agents:
    - handle: research
      url: http://research:8790
      token_env: RESEARCH_TOKEN
```

Each entry becomes one tool, `agent__research`, alongside the natives and MCP tools, wired in through the same `#buildTools` path. The tool's description comes from the callee's agent card, fetched once at startup; an unreachable colleague fails the boot the same way a missing env var does. The input schema is a message; the result is the callee's reply text.

## What keeps a fleet bounded

- **The caller's `permissions.net` must name the callee's host.** An agent that may call `research:8790` says so in its permission block, and the engine enforces it like any other host. Composition gets no side channel.
- **The callee runs entirely under its own config.** Its permissions, its `max_steps`, its model. A caller can ask; it can never borrow capability.
- **Recursion is capped.** Agent A calling B calling A is one prompt away, so every A2A message carries a hop count and the trigger rejects past a small default. Each hop also burns a full run's budget on the callee, which makes runaway chains expensive enough to notice in the audit trail even before the cap.
- **Both sides write audit.** The caller records an `agent` audit entry with the target and message; the callee records a normal run with trigger `a2a`. Tokens land where they were spent.

## The fleet story

A fleet is a compose file, which is already the deployment model. Service names are hostnames, so `url: http://research:8790` works on the compose network with no discovery machinery, and the shared tokens travel through the same env-file the rest of the secrets use. Hermetic mode (Plan 6) picks the callee hosts out of `tools.agents` when deriving the net allowlist, and the `a2a` trigger claims a listen right like the webhook trigger does.

## Phasing

1. **The `a2a` trigger.** Card generation, the synchronous message endpoint, bearer auth, hop-count check. An agent becomes callable.
2. **The `agent__<handle>` tool.** Card fetch at startup, the tool wiring, the `agent` audit kind. Agents start calling each other.
3. **Streaming and discovery.** Task-update streaming through the trigger, and whatever card/registry story the ecosystem settles on.

## Open questions

- Streaming through composition: when the callee streams, does the caller's tool result wait for completion in v1 (likely yes), and what does the eventual pass-through look like?
- The agent card presents an identity. The self-chosen name, the operator's handle, or both? The naming ritual (Plan 1) says agents present their own name; a card read by strangers may want the stable handle too.
- Auth topology: one token per callee, per caller-callee pair, or one fleet token? Per-callee (as sketched) is the simplest thing that scopes.
- Cross-fleet calls over the public internet: out of scope until someone needs it, but the card format should avoid baking in compose-network assumptions.
- Does the future `chat` trigger (Plans 1 and 5, Looped Chat) become a consumer of this same message surface, or stay its own SSE design?
