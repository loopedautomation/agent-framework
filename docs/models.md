---
title: "Overview"
description: "The provider dialects, how API keys are supplied, and retry behavior."
---

Every agent names its model in the required `model:` block; there is no fleet-wide default. The `provider` field is a **dialect**: three dialects cover effectively every hosted and local endpoint, and swapping providers is a one-line change. The short version lives in [Agent Config](agent-file.md#model); this page covers what the dialects share, and each provider has its own page: [OpenAI](openai.md), [Anthropic](anthropic.md) and [Codex](codex.md).

```yaml
model:
  provider: openai-compatible   # or: anthropic, codex
  id: gpt-5.4-mini
```

## The three dialects

| | [`openai-compatible`](openai.md) | [`anthropic`](anthropic.md) | [`codex`](codex.md) |
| --- | --- | --- | --- |
| Speaks to | OpenAI, Ollama, vLLM, LiteLLM, OpenRouter — anything serving the chat-completions API | The native Anthropic Messages API | The ChatGPT Codex backend |
| Default endpoint | `https://api.openai.com/v1` | `https://api.anthropic.com` | `https://chatgpt.com/backend-api/codex` |
| Auth | `OPENAI_API_KEY` | `ANTHROPIC_API_KEY` | `codex login` credentials (no key) |
| `base_url` | Any compatible endpoint — this is how local models work | Anthropic-compatible proxies | Rarely needed |

`id` is the plain model identifier the endpoint expects — `gpt-5.4-mini`, `claude-sonnet-5`, `llama3.1`. There is no combined `provider/model` string syntax; the two fields stay separate, which is what makes `base_url` proxies transparent.

## API keys

The config names an environment variable; the key itself stays out of the file. At startup the runtime reads the key from the environment variable named by `api_key_env`, defaulting to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` per provider:

```yaml
model:
  provider: openai-compatible
  id: gpt-5.4-mini
  api_key_env: OPENROUTER_API_KEY   # optional: which env var holds the key
```

Supply the variable the way your deployment supplies env: `export` locally, `--env-file .env` with `docker run`, `env_file:` in compose. One subtlety: the provider key is read straight from the process environment — unlike `${VAR}` references in the [`env:` block](agent-file.md#env), it does not fall back to `/run/secrets/<VAR>` files.

A missing key fails at startup, before any event is handled:

```
missing API key: set OPENAI_API_KEY (or point model.api_key_env at the right env var)
```

Two exceptions: `openai-compatible` with an explicit `base_url` needs no key, because [local models](openai.md#local-models) usually don't have one; and the [`codex` provider](codex.md) authenticates with ChatGPT subscription credentials, so no key env var applies.

## The small model

```yaml
model:
  provider: openai-compatible
  id: gpt-5.4-mini
  small: gpt-5.4-nano
```

`small` routes the framework's cheap internal calls — today, the [naming step](agent-file.md#identity-handle-description--and-the-name) on first boot — to a smaller model. It defaults to the main `id`; set it to a small model and those calls cost close to nothing.

## When the provider fails

Transient failures retry themselves: rate limits (HTTP 429), overload (5xx), and network errors get up to three attempts with exponential backoff (500 ms, then 1 s). Auth failures (401/403) and malformed requests (other 4xx) fail immediately — retrying wouldn't change the answer.

A call that still fails ends the run with status `error_provider` and a one-line reason. The *run* fails; the *service* stays up, waiting for the next event — statuses are in the [limits table](agent-file.md#limits).

## Fallbacks

**`fallbacks`** declares models to try, in order, when the primary fails — each entry only after the primary's own transient retries (above) are exhausted. A run ends `error_provider` only when the primary *and* every fallback have failed.

```yaml
model:
  provider: anthropic
  id: claude-sonnet-5
  fallbacks:
    - claude-haiku-5              # a bare string: a model id on this provider
    - provider: openai-compatible # an object: cross to a different provider
      id: gpt-5.4-mini
      api_key_env: OPENAI_API_KEY
```

A bare string is shorthand for a model id on the primary's provider. The object form overrides any of `provider`, `id`, `base_url`, and `api_key_env`, inheriting the rest from the primary — which is what lets a fallback cross to a different provider. Each fallback's provider is built at startup, so a missing API key on a fallback fails fast (the same startup error as a missing primary key), never mid-run.

Fallbacks apply to the agent's own work. The one-time [naming ritual](agent-file.md#identity-handle-description--and-the-name) always uses the primary (via `small`) and degrades to the handle on failure, so it is unaffected.

## What is deliberately not configurable

There are no `temperature` or max-output-token fields; requests use the provider's defaults (the `anthropic` dialect caps output at 4096 tokens per call). If you need one of these controls, put a rewriting proxy such as LiteLLM behind `base_url`. The exhaustive field list is the [JSON Schema](https://github.com/loopedautomation/agent-framework/blob/main/schema/agent.json), enforced [in your editor](agent-file.md#editor-support) as you type.
