---
title: "OpenAI"
description: "The openai-compatible dialect: OpenAI itself, proxies like OpenRouter and LiteLLM, and local models."
---

The `openai-compatible` provider speaks the chat-completions API, and that dialect reaches far beyond OpenAI itself: Ollama, vLLM, LiteLLM, OpenRouter and most hosted gateways all serve it. If an endpoint advertises OpenAI compatibility, this is the provider to point at it.

```yaml
model:
  provider: openai-compatible
  id: gpt-5.4-mini
```

With no `base_url`, requests go to `https://api.openai.com/v1` and the key is read from `OPENAI_API_KEY`. How keys are named and supplied is covered in [Providers](models.md#api-keys).

## Proxies and gateways

`base_url` points the dialect at any compatible endpoint, and `api_key_env` names the env var that endpoint's key lives in:

```yaml
model:
  provider: openai-compatible
  id: anthropic/claude-sonnet-5
  base_url: https://openrouter.ai/api/v1
  api_key_env: OPENROUTER_API_KEY
```

`id` stays a plain model identifier in whatever form the endpoint expects. There is no combined `provider/model` string syntax in the config itself; the two fields stay separate, which is what makes proxies transparent.

## Local models

```yaml
model:
  provider: openai-compatible
  id: llama3.1
  base_url: http://localhost:11434/v1   # Ollama
```

With a `base_url` set, no API key is required, because local models usually don't have one. `af init --provider local` scaffolds exactly this shape.

When the agent runs in a container, remember `localhost` is the container itself: use `http://host.docker.internal:11434/v1` to reach a model server on the host (on Linux, add `--add-host=host.docker.internal:host-gateway`).
