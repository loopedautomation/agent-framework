---
title: "Models"
description: "The provider dialects, API keys, subscription auth, local models, and retry behavior."
---

Every agent names its model in the required `model:` block; there is no fleet-wide default. The `provider` field is a **dialect**: three dialects cover effectively every hosted and local endpoint, and swapping providers is a one-line change. The short version lives in [Agent Config](agent-file.md#model); this page covers the details.

```yaml
model:
  provider: openai-compatible   # or: anthropic, codex
  id: gpt-5.4-mini
```

## The three dialects

| | `openai-compatible` | `anthropic` | `codex` |
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

Two exceptions: `openai-compatible` with an explicit `base_url` needs no key, because local models usually don't have one; and the `codex` provider authenticates with subscription credentials, covered next.

## Codex subscription

```yaml
model:
  provider: codex
  id: gpt-5-codex
```

The `codex` provider runs your agents on an OpenAI Codex (ChatGPT Plus, Pro or Team) subscription. There is no API key. The runtime signs requests with the OAuth credentials the [Codex CLI](https://github.com/openai/codex) writes to `~/.codex/auth.json` when you run `codex login`. When the access token nears expiry the runtime refreshes it and writes the new tokens back to the file, so the CLI and your agents keep working from the same login. If your credentials live somewhere else, set `CODEX_HOME`.

When the agent runs in a container, mount the credential directory into the runtime user's home:

```yaml
volumes:
  - ~/.codex:/home/looped/.codex   # `codex login` credentials
```

`af init --provider codex` scaffolds this shape. A read-only mount also works; the refreshed token then lives only in process memory and gets refreshed again on the next start.

Where mounting a file is awkward (Coolify, a PaaS with env-only config), you can instead paste the contents of `auth.json` into a `CODEX_AUTH_JSON` env var and skip the mount. The trade-off is that an env var never gets the rotated refresh token written back, so a long-lived deployment can eventually stop refreshing; when the logs show auth errors, run `codex login` again and re-paste. The file mount is the more durable option.

On a ChatGPT Business or Enterprise workspace there is a cleaner credential: [Codex access tokens](https://developers.openai.com/codex/enterprise/access-tokens), the machine tokens admins mint in the workspace console for automation. Put one in `CODEX_ACCESS_TOKEN` and the runtime uses it directly; it wins over `CODEX_AUTH_JSON` and the credential file when more than one is set. These tokens are made for servers: scoped to a workspace identity, revocable one at a time, with an expiry you choose at creation. When one expires, runs fail with auth errors until you mint a replacement.

Two things to know. Usage counts against your subscription's rate limits, and those limits are shared with your own Codex sessions on the same account. And the backend serves the Codex model family (`gpt-5-codex`, `gpt-5`); for other OpenAI models, use `openai-compatible` with an API key.

## Local models

```yaml
model:
  provider: openai-compatible
  id: llama3.1
  base_url: http://localhost:11434/v1   # Ollama
```

`base_url` points the dialect at any compatible endpoint — Ollama, vLLM, a LiteLLM proxy — and with it set, no API key is required. `af init --provider local` scaffolds exactly this shape.

When the agent runs in a container, remember `localhost` is the container itself: use `http://host.docker.internal:11434/v1` to reach a model server on the host (on Linux, add `--add-host=host.docker.internal:host-gateway`).

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

**`fallbacks`** declares model ids to try in order when the primary fails. The schema accepts and validates the field today, but the runtime chain hasn't landed yet — until it does, a failed primary ends the run `error_provider` regardless of the list.

## What is deliberately not configurable

There are no `temperature` or max-output-token fields; requests use the provider's defaults (the `anthropic` dialect caps output at 4096 tokens per call). If you need one of these controls, put a rewriting proxy such as LiteLLM behind `base_url`. The exhaustive field list is the [JSON Schema](https://github.com/loopedautomation/agent-framework/blob/main/schema/agent.json), enforced [in your editor](agent-file.md#editor-support) as you type.
