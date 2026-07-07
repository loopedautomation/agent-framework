---
title: "Codex"
description: "Run agents on an OpenAI Codex (ChatGPT) subscription: codex login credentials, env-var deploys and machine tokens."
---

The `codex` provider runs your agents on an OpenAI Codex (ChatGPT Plus, Pro or Team) subscription. There is no API key. The runtime signs requests with the OAuth credentials the [Codex CLI](https://github.com/openai/codex) writes to `~/.codex/auth.json` when you run `codex login`.

```yaml
model:
  provider: codex
  id: gpt-5-codex
```

The backend serves the Codex model family (`gpt-5-codex`, `gpt-5`); for other OpenAI models, use [openai-compatible](openai.md) with an API key.

## Logging in

Install the Codex CLI and sign in once on a machine with a browser:

```sh
npm i -g @openai/codex
codex login
```

That writes your tokens to `~/.codex/auth.json`. From then on the runtime handles the lifecycle itself: when the access token nears expiry it refreshes it and writes the new tokens back to the file, so the CLI and your agents keep working from the same login. If your credentials live somewhere other than `~/.codex`, set `CODEX_HOME`.

For a headless server, sign in on your laptop and copy the file over (`scp ~/.codex/auth.json server:~/.codex/`). This is the pattern OpenAI documents for CI runners. There is also a beta device-code flow (`codex login --device-auth`) that signs in from a headless box directly, once you enable it in your ChatGPT settings.

## Containers

Mount the credential directory into the runtime user's home:

```yaml
volumes:
  - ~/.codex:/home/looped/.codex   # `codex login` credentials
```

`af init --provider codex` scaffolds this shape. A read-only mount also works; the refreshed token then lives only in process memory and gets refreshed again on the next start.

Where mounting a file is awkward (Coolify, a PaaS with env-only config), paste the contents of `auth.json` into a `CODEX_AUTH_JSON` env var and skip the mount. The trade-off is that an env var never gets the rotated refresh token written back, so a long-lived deployment can eventually stop refreshing; when the logs show auth errors, run `codex login` again and re-paste. The file mount is the more durable option.

## Machine tokens

On a ChatGPT Business or Enterprise workspace there is a cleaner credential: [Codex access tokens](https://developers.openai.com/codex/enterprise/access-tokens), the machine tokens admins mint in the workspace console for automation. Put one in `CODEX_ACCESS_TOKEN` and the runtime uses it directly; it wins over `CODEX_AUTH_JSON` and the credential file when more than one is set. These tokens are made for servers: scoped to a workspace identity, revocable one at a time, with an expiry you choose at creation. When one expires, runs fail with auth errors until you mint a replacement.

## What you're trusting the server with

On a personal plan, the tokens from `codex login` are your whole ChatGPT account. Anyone who reads them can spend your subscription's Codex quota as you, and revoking them means signing out sessions on the account. Treat `auth.json` and `CODEX_AUTH_JSON` the way you'd treat a password: fine on a server you'd also trust with your SSH key, wrong for shared or multi-tenant infrastructure. For those, use a machine token on a workspace plan, or a scoped API key via [openai-compatible](openai.md).

Usage also counts against your subscription's rate limits, and those limits are shared with your own Codex sessions on the same account. A busy agent and a busy you compete for the same quota.
