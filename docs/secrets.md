---
title: "Secrets"
description: "How secrets reach tools without reaching the model: scoped env, redaction on every output surface, and server-side credentials for HTTP."
---

Your agent needs a GitHub token to do its job, and the model driving it should never see that token. Those two things are in tension, because the model is the thing deciding what to run.

The framework closes that gap in three places. Secrets are scoped to the tools that need them, so they never enter the model's starting context. Anything a tool hands back gets scrubbed of known secret values, so a tool cannot smuggle one in either. And for authenticated HTTP, the runtime attaches the credential itself, so the model never has to construct an `Authorization` header at all.

## The config names the variable

```yaml
env:
  GITHUB_TOKEN: ${GITHUB_TOKEN}
```

Each `${VAR}` reference resolves at startup, from the process environment first and then from `/run/secrets/<VAR>` (Docker Compose file secrets). A reference that resolves to nothing fails right there at startup, before any event is handled, so you find out on boot instead of mid-run in front of the model.

The resolved values go into the environment of `run_bash` subprocesses and MCP servers. They are not in the system prompt and they are not in any tool schema. The agent can run `gh issue list` and the token is already there in the environment for `gh` to pick up.

## A tool can always echo a secret back

Scoping the environment gets you most of the way, and then you hit the obvious hole. `run_bash` can run `printenv`. An MCP server can quote the credential it just failed to authenticate with. An API can reject a request and hand you back the key you sent it. Every one of those comes back as a tool result, and a tool result is the model's next message.

So there is a second layer. On startup the agent resolves every environment variable its config references and builds a redactor from those values. Everything on the way out of a tool goes through it:

- tool results, before they become messages the model reads
- the run's reply, and the transcript saved to SQLite
- run and audit records, and the `/runs` and `/audit` responses on the status API
- the run event stream, which is what the REPL and trace exporters consume
- log lines, including the API error bodies triggers print when a call fails
- provider error bodies, which routinely quote the key that just failed

A matched value is replaced with `[redacted]`. The redactor also catches the value URL-encoded, base64-encoded and JSON-escaped, because a secret rarely comes back in the same shape it went out in.

The list of secrets is built from what the config already tells us: the `${VAR}` references in `env` and in each MCP server's `env`, the `*_env` names your model and triggers authenticate with, and the references in `http.auth`. You don't list anything twice.

A literal you write directly into the config is not treated as a secret. It's committed to your repo, so it isn't one, and redacting `LOG_LEVEL: debug` would shred ordinary tool output for nothing. Values shorter than six characters are skipped for the same reason.

## Configuration the agent has to read: `public`

Everything in `env` is a secret by definition, and that coupling is usually what you want. It is wrong for one class of value: configuration the agent must be able to see in its own output. A PostHog project id, an AWS account number, a region. Redact one of those and it disappears from the URLs the agent builds and the responses it reads back — which looks, from the outside, like an agent that cannot see its own configuration.

`public` is the same scoping without the redaction:

```yaml
env:
  POSTHOG_API_KEY: ${POSTHOG_API_KEY}     # secret — scoped, redacted
public:
  POSTHOG_PROJECT_ID: ${POSTHOG_PROJECT_ID}  # config — scoped, visible
```

Both blocks resolve at startup the same way, both fail on a missing reference the same way, and both are scoped into `run_bash` subprocesses and MCP servers. The only difference is that `public` values never enter the redactor. A name in both blocks takes the `env` value, so anything that is a secret somewhere stays a secret.

`public` also takes numbers and booleans without quoting — these are ids, ports and regions, and YAML reads a bare `12345` as a number:

```yaml
public:
  POSTHOG_PROJECT_ID: 12345
  AWS_REGION: eu-west-1
```

Two things follow from `public` being visible. It is reported by the same boot-time env list as everything else, so a deploy surface provisioning an agent still knows to ask for it. And it is genuinely not protected — anything you put here can reach a tool result, a log line and a trace. If you find yourself reaching for it to silence a redaction that is getting in your way, the value probably belongs in `env` and the problem is elsewhere.

## Credentials for HTTP, attached server side

`http_request` is the case where scoped environment doesn't help you. The tool takes headers from the model, so an authenticated API means the model has to know the key and type it into an argument. That puts the secret straight back into the context you were keeping it out of.

Instead, declare the credential and let the runtime attach it:

```yaml
permissions:
  net: [api.stripe.com]

http:
  auth:
    - url: https://api.stripe.com
      header: Authorization          # this is the default, so you can leave it out
      value: Bearer ${STRIPE_KEY}
```

The model asks for a URL. After the tool call comes back, the runtime matches the URL against each `url` prefix, and the header goes on the request on its way out. The longest matching prefix wins, so one endpoint can override a rule covering the whole host. If the model invents a placeholder `Authorization` header of its own, the configured credential overwrites it.

The tool's description tells the model which URLs are already authenticated, so it stops trying to help. The value never appears in the description, the arguments or the result.

The host still has to be in `permissions.net`. Credentials say how to authenticate; [permissions](permissions.md) still say where the agent is allowed to go. Both take env references, so a self-hosted instance's address need not be committed either:

```yaml
permissions:
  net: ["${COOLIFY_HOST}"]

http:
  auth:
    - url: https://${COOLIFY_HOST}
      value: Bearer ${COOLIFY_API_TOKEN}
```

The `url` is not a secret and is not redacted — it names where requests go, and scrubbing it would blank the host out of every tool result. Only `value` is treated as a credential. Redirects are not followed, so a redirect can't carry your credential to a host you never allowed.

## Redacting something the config doesn't name

Sometimes a secret reaches the agent without the config ever mentioning it. An MCP server image with a key baked into it, for example. You can name the extra references, and add header names to scrub by name:

```yaml
redact:
  values: ["${LEGACY_API_KEY}"]
  headers: [x-internal-signature]
```

Header and field names are scrubbed whatever they hold, which is what catches a token the agent fetched at runtime and the framework never resolved. `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `api-key`, `x-auth-token` and `x-access-token` are handled without you listing them.

## What this doesn't do

Redaction works on values the framework knows about. A secret the agent discovers at runtime, in a file it was allowed to read or a response body from an API, is not in the redactor and will not be scrubbed by value. The header rules catch the common shape of that, and `redact.values` catches the ones you can name in advance, but there is no general defence against an agent finding a credential you never told it about. Scope `read:` accordingly.

Redaction also happens on the way out of a tool, so it does not stop a secret being *used*. `run_bash` with a permitted `curl` can send `$GITHUB_TOKEN` anywhere `net:` allows. The permission allowlists are what bound that, and this is one more reason to keep `net:` tight.
