---
title: "Tools"
description: "The native toolset, MCP servers, and tool search — capability added deliberately, never by default."
---

The base toolset is deliberately small: a handful of natives, gated by permissions. Everything beyond that is added explicitly — a [skill](skills.md) plus a CLI, or an MCP server — because every tool an agent carries is attack surface, context cost, and one more way for a small model to get confused.

## Native tools

**Tools follow permissions.** A native exists for the agent only if the [permissions](permissions.md) block grants what it needs — no dead tool schemas burning context, and nothing to misuse:

| Tool | Present when | Notes |
| --- | --- | --- |
| `current_time` | always | the one freebie |
| `run_bash` | `permissions.run` grants executables | statically checked per executable; output capped at 8k chars |
| `http_request` | `permissions.net` grants hosts | GET/POST/PUT/PATCH/DELETE/HEAD; 30s timeout; body capped at 8k chars |
| `read_file` | `permissions.read` grants paths | capped at 8k chars |
| `write_file` | `permissions.write` grants paths | creates parent directories |
| `read_skill` | `skills:` lists any | [progressive disclosure](skills.md#progressive-disclosure) |
| `search_tools` | tool search is deferring | see below |

An agent with no `permissions:` block gets `current_time` and whatever `read_skill` its skills warrant — nothing else.

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
- Each server sees only its own `env:` block (values may be `${VAR}` references), never the agent's environment.
- Results are truncated at 8k chars; servers connect at startup and close on shutdown.

## Tool search

`include:` is the manual way to keep context lean; tool search is the automatic one. When the total toolset grows past 10, MCP tool schemas stay out of context entirely — the model gets a single `search_tools` schema instead of forty, and activates exactly what the task needs, mid-run:

```yaml
tools:
  search: auto   # auto (default) | on | off
```

- `auto` — defer MCP tools when the agent carries more than 10 tools in total; below that, everything loads normally.
- `on` / `off` — always or never defer, regardless of count.

A search is a keyword match against tool names and descriptions; the top matches (up to five, with a relevance cutoff) become callable for the rest of the run. Native and skill tools are never deferred — they're small and framework-owned. `include:` and `search` compose: filter the server down to what the agent should ever see, and let search handle when it sees it.

## Custom tools

`tools.custom` (TypeScript tool modules) is planned but **not yet implemented** — the config loader rejects it loudly rather than silently ignoring it ([#12](https://github.com/loopedautomation/agent-framework/issues/12)). Today, the escape hatch is the same as ever: give the agent a CLI and a [skill](skills.md).
