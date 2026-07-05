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
| `http_request` | `permissions.net` grants hosts | GET/POST/PUT/PATCH/DELETE/HEAD; 30s timeout; body capped at 8k chars |
| `read_file` | `permissions.read` grants paths | capped at 8k chars |
| `write_file` | `permissions.write` grants paths | creates parent directories |
| `read_skill` | `skills:` lists any | [progressive disclosure](skills.md#progressive-disclosure) |
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
- We strongly recommend `include:`. A 40-tool server puts 40 schemas into a small model's context; expose the three you actually need.
- Each server sees only its own `env:` block (values may be `${VAR}` references); the agent's own environment stays private.
- Results are truncated at 8k chars; servers connect at startup and close on shutdown.

The [gh-issues-mcp example](https://github.com/loopedautomation/agent-framework/tree/main/examples/gh-issues-mcp) is a complete deployment of this block: the Dockerfile installs the GitHub MCP server binary and the agent file exposes five of its tools. Its sibling [gh-issues-cli](https://github.com/loopedautomation/agent-framework/tree/main/examples/gh-issues-cli) does the same job with the `gh` CLI and a skill, so the two read as a side-by-side comparison.

## Tool search

`include:` keeps context lean by hand; tool search does the same thing automatically. When the total toolset grows past 10, MCP tool schemas stay out of context entirely. The model gets a single `search_tools` schema, and it activates the tools the task needs while the run is underway:

```yaml
tools:
  search: auto   # auto (default) | on | off
```

- `auto` - defer MCP tools when the agent carries more than 10 tools in total; below that, everything loads normally.
- `on` / `off` - always or never defer, regardless of count.

A search is a keyword match against tool names and descriptions; the top matches (up to five, with a relevance cutoff) become callable for the rest of the run. Native and skill tools always load, since they are small and framework-owned. `include:` and `search` compose: `include:` filters the server down to what the agent should ever see, and search decides when it sees it.

## Custom tools

`tools.custom` (TypeScript tool modules) is planned and hasn't landed yet; the config loader rejects the key loudly, so a config that relies on it fails immediately ([#12](https://github.com/loopedautomation/agent-framework/issues/12)). In the meantime, give the agent a CLI and a [skill](skills.md).
