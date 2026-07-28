---
title: "Anthropic"
description: "The anthropic dialect: the native Messages API, keys and compatible proxies."
---

The `anthropic` provider speaks the native Anthropic Messages API. Use it for Claude models on Anthropic's own endpoint, or for any proxy that serves the same API shape.

```yaml
model:
  provider: anthropic
  id: claude-sonnet-5
```

With no `base_url`, requests go to `https://api.anthropic.com` and the key is read from `ANTHROPIC_API_KEY`. Point `api_key_env` at a different env var if your key lives elsewhere; the mechanics are in [Providers](models.md#api-keys).

```yaml
model:
  provider: anthropic
  id: claude-sonnet-5
  base_url: https://my-litellm-proxy.internal   # any Messages-API-compatible endpoint
  api_key_env: PROXY_API_KEY
```

## Claude subscription auth

Instead of an API key, the provider accepts an OAuth token from a Claude Pro/Max subscription. Generate one with the Claude Code CLI:

```bash
claude setup-token
```

and export it as `CLAUDE_CODE_OAUTH_TOKEN` (no config change needed — the provider falls back to it when `ANTHROPIC_API_KEY` is unset). A token pasted into `ANTHROPIC_API_KEY`, or any env var named by `api_key_env`, also works: the provider recognizes the `sk-ant-oat` prefix and switches to Bearer auth with the `oauth-2025-04-20` beta header automatically.

> **Disclaimer.** Anthropic officially supports subscription usage through Claude Code and the Claude Agent SDK — not through direct Messages API calls. This token path works today, but Anthropic may restrict or reject non-Claude-Code use of subscription tokens at any time, and relying on it may be against their terms of service. Use it at your own risk, prefer an API key for anything production-critical, and expect requests to fail with an auth error if enforcement changes. Subscription tokens also draw from your plan's 5-hour/weekly usage windows rather than metered billing, so a busy agent competes with your own interactive usage.

One behavior worth knowing: this dialect caps output at 4096 tokens per call. The Messages API requires an explicit maximum and the framework deliberately has no config field for it, so we picked a fixed value. If a run needs longer single responses, put a rewriting proxy such as LiteLLM behind `base_url`; the reasoning is in [what is deliberately not configurable](models.md#what-is-deliberately-not-configurable).
