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

Two caveats: subscription tokens are subject to your plan's usage limits rather than metered billing, and Anthropic's terms position subscription access around Claude Code — direct API use of these tokens may be restricted at their discretion. If a request is rejected with an auth error despite a valid token, fall back to an API key.

One behavior worth knowing: this dialect caps output at 4096 tokens per call. The Messages API requires an explicit maximum and the framework deliberately has no config field for it, so we picked a fixed value. If a run needs longer single responses, put a rewriting proxy such as LiteLLM behind `base_url`; the reasoning is in [what is deliberately not configurable](models.md#what-is-deliberately-not-configurable).
