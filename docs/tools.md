---
title: "Tools"
description: "The native toolset, MCP servers and tool search. Every capability is added deliberately."
---

We kept the base toolset small: a handful of native tools, gated by permissions. Anything beyond that is something you add deliberately, either a [skill](skills.md) plus a CLI or an MCP server. Every tool an agent carries is more attack surface, more context and one more way for a small model to get confused, so the framework ships with very little and lets you add the rest.

## Native tools

Tools follow permissions. A native tool exists for the agent only when the [permissions](permissions.md) block grants what it needs. This means that no unused tool schema takes up context, and there is nothing sitting there to misuse:

| Tool | Present when | Notes |
| --- | --- | --- |
| `current_time` | always | the only tool granted unconditionally |
| `run_bash` | `permissions.run` grants executables | statically checked per executable; output capped at 8k chars |
| `http_request` | `permissions.net` grants hosts | GET/POST/PUT/PATCH/DELETE/HEAD; 30s timeout; body capped at 8k chars; [credentials](secrets.md#credentials-for-http-attached-server-side) attached server side |
| `read_file` | `permissions.read` grants paths | capped at 8k chars |
| `write_file` | `permissions.write` grants paths | creates parent directories |
| `read_skill` | `skills:` lists any | [progressive disclosure](skills.md#progressive-disclosure) |
| `remember` / `recall` / `list_memories` / `forget` | `memory.persistent: true` | [persistent memory](memory.md#persistent-memory-persistent) |
| `schedule` / `list_schedules` / `unschedule` | `schedules:` block present | [agent-created schedules](scheduling.md), capped at `schedules.max` |
| `search_tools` | tool search is deferring | see below |

An agent with no `permissions:` block gets `current_time`, plus `read_skill` if it has skills. Nothing else.

## MCP servers

Use an MCP server when a good one exists and is worth the context cost:

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
- We strongly recommend `include:`. A 40-tool server puts 40 schemas into a small model's context; expose the three you actually need. `include:` is also the permission surface for MCP: a tool you didn't include does not exist for the agent.
- `readonly: true` on a server exposes only tools whose `readOnlyHint` annotation marks them read-only, which is a good fit when the job only reads. The hint is self-reported by the server, so treat this as a guard against wiring write tools into a read-only job; the trust decision is still whether to declare the server at all.
- Every MCP call is recorded in the audit trail with the tool name and whether it succeeded, alongside the run's permission decisions.
- Each server sees only its own `env:` block (values may be `${VAR}` references); the agent's own environment stays private.
- Results are truncated at 8k chars; servers connect at startup and close on shutdown.

For a sense of when to skip the MCP route entirely: the [gh-issues-bot example](https://github.com/loopedautomation/agent-framework/tree/main/examples/gh-issues-bot) covers a full GitHub integration with the `gh` CLI and a skill, and the same block above is what its config would grow if the CLI ever stopped being enough.

## Tool search

`include:` keeps context lean by hand; tool search does the same thing automatically. When the total toolset grows past 10, MCP tool schemas stay out of context entirely. The model gets a single `search_tools` schema, and it activates the tools the task needs while the run is underway:

```yaml
tools:
  search: auto   # auto (default) | on | off
```

- `auto` - defer MCP tools when the agent carries more than 10 tools in total; below that, everything loads normally.
- `on` / `off` - always or never defer, regardless of count.

A search is a keyword match against tool names and descriptions; the top matches (up to five, with a relevance cutoff) become callable for the rest of the run. Native and skill tools always load, since they are small and framework-owned. `include:` and `search` compose: `include:` filters the server down to what the agent should ever see, and search decides when it sees it.

## Code you write yourself

There is no way to point the config at a TypeScript file and have the framework load it as a tool. We looked at it and decided against it. A tool module gets dynamically imported into the agent process, which means it runs with the agent's full permissions, and we would be maintaining a second extension mechanism that does what MCP already does.

So when you have code of your own that the agent should be able to call, you have two options. Wrap it in an MCP server and declare it under `tools.mcp`, which keeps it in its own process with its own permissions. Or give the agent a CLI and a [skill](skills.md) that explains how to use it, which is usually the cheaper of the two.

If you put `tools.custom` in a config, the loader rejects it and tells you the same thing.
