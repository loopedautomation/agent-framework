---
"@looped/core": minor
---

MCP calls join the audit trail, and servers gain a `readonly:` flag.

Every `mcp__<server>__<tool>` call is now recorded in the run's audit trail (kind `mcp`, with the
tool name and whether it succeeded), alongside permission decisions. A new `readonly: true` option
on `tools.mcp` servers exposes only tools whose `readOnlyHint` annotation marks them read-only, as a
guard against wiring write tools into a read-only job.
