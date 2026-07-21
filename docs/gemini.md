---
title: "Gemini"
description: "The gemini dialect: the native Gemini API, keys and compatible proxies."
---

The `gemini` provider speaks the native Gemini API (`generateContent`). Use it for Gemini models on Google's own endpoint, or for any proxy that serves the same API shape.

```yaml
model:
  provider: gemini
  id: gemini-3.6-flash
```

With no `base_url`, requests go to `https://generativelanguage.googleapis.com` and the key is read from `GEMINI_API_KEY` — get one from [Google AI Studio](https://aistudio.google.com/apikey). Point `api_key_env` at a different env var if your key lives elsewhere; the mechanics are in [Providers](models.md#api-keys).

```yaml
model:
  provider: gemini
  id: gemini-3.6-flash
  base_url: https://my-gemini-proxy.internal   # any generateContent-compatible endpoint
  api_key_env: PROXY_API_KEY
```

Gemini is also reachable through Google's OpenAI-compatible endpoint with the [`openai-compatible`](openai.md) dialect (`base_url: https://generativelanguage.googleapis.com/v1beta/openai/`). Prefer the native dialect: it reports thinking-token usage correctly and doesn't depend on the compatibility layer's dialect mapping.

Two behaviors worth knowing:

- **Tool-call ids are synthesized.** Gemini matches tool results to calls by function name rather than id, and not every model version emits ids at all, so the provider mints ids of the form `<name>#<n>` and recovers the name when replaying tool results. This is invisible in normal operation; it only matters if you read raw session transcripts.
- **Thinking tokens count as output.** Reasoning models like Gemini 3.6 Flash report thought tokens separately (`thoughtsTokenCount`); they are billed as output, so the provider adds them to the run's output-token usage.

For reaching Gemini models on Vertex AI (service-account auth rather than API keys), put a rewriting proxy such as LiteLLM behind `base_url` — the framework deliberately holds no cloud-SDK credentials.
