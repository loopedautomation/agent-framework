---
name: looped-authoring
description: Create Looped AF agent projects from a description, using af init and the config schema.
---

# Building Looped agents

You create agent projects. The recipe: scaffold deterministically with `af init`, then fill in the semantic parts yourself. Never hand-write boilerplate the scaffolder generates.

## 1. Decide the shape from the request

- **handle**: lowercase-with-hyphens, from the job (e.g. "summarize RSS to Discord" → `rss-digest`)
- **trigger**: reacting to Discord messages → `discord`; called by other systems → `webhook`; on a schedule → `cron`; interactive-only → `none`
- **provider**: default `openai-compatible` unless the request names one
- **clis**: only binaries the job truly needs (e.g. `gh` for GitHub work). Most agents need none — minimalism is the house style.
- **deploy**: default `compose`; use what the request asks for (`local`, `docker`, `paas-git`, `paas-env`)

If the request is missing something essential (e.g. which channel, which repo), ask **one** short clarifying question before building. Otherwise build immediately.

## 2. Scaffold

```sh
deno task af init <handle> --dir agents --trigger <trigger> --provider <provider> --deploy <deploy> --clis "<a,b or empty>"
```

It creates `agents/<handle>/` with agent.yaml, .env.example, README, and the deployment files.

## 3. Fill in the TODOs

Read `agents/<handle>/agent.yaml` (read_file), then rewrite it with `write_file`, replacing every TODO:

- **description**: one specific line.
- **purpose**: the whole job description — what to do, how to behave, tone, and *when to stay quiet*. Write it like a brief for a competent new hire. Be concrete: name channels, repos, formats. 4–10 lines.
- **trigger details**: real channel names, real cron schedules, real prompts.
- Add `permissions` only for what the job needs (hosts for `http_request`, paths for files). The scaffold already added `run:` for any CLIs.

Keep everything else the scaffolder wrote (the modeline comment, memory, structure).

## 4. Validate — never skip

```sh
deno task af validate agents/<handle>/agent.yaml
```

If it fails, read the error, fix the file, validate again. Do not report success until validation passes.

## 5. Reply

Report: the file list, the one-line description, any env vars the deployer must provide (from .env.example), and the deploy command from the README. Keep it short — the project's README carries the detail.

## Config quick reference

- `handle` (what you call it; the agent names itself), `description`, `model.provider` (`openai-compatible`|`anthropic`), `model.id`, `purpose`
- triggers: `discord` (channels, require_mention, from_users, reply_channel, allow_silence), `webhook` (path, port, token_env — required), `cron` (schedule, prompt)
- `permissions`: `net` (hosts), `run` (executables), `read`/`write` (path prefixes) — deny-by-default, grant only what the job needs
- `skills` (paths), `tools.mcp` (name + command|url + env + include)
- `memory.scope`: `thread`|`none` · `limits`: `max_steps` (default 20), `max_cost` (needs `model.pricing`)
- Unknown keys are hard errors. `system_prompt` and `nickname` are the old names for `purpose` and `handle`.
