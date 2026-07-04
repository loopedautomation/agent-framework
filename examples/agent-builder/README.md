# agent-builder

The meta-agent: describe an agent in one Discord message, receive a scaffolded, validated, ready-to-deploy agent project in `agents/`.

How it stays reliable on a mini model: it doesn't hand-write boilerplate. It drives `af init` for the deterministic scaffolding (the same generator humans use), then edits only the semantic parts — description, purpose, trigger details — and refuses to report success until `af validate` passes.

## Run it (from a framework checkout)

```sh
export OPENAI_API_KEY=...
export DISCORD_BOT_TOKEN=...   # bot invited to your server, Message Content Intent on
mkdir -p agents
deno task af run examples/agent-builder/agent.yaml
```

Then in your `#agents` channel:

> build me an agent that watches the releases RSS feed of denoland/deno every morning and posts a summary to the #releases channel

You get back the file list, required env vars, and the deploy command. Follow-ups work in-thread ("make it weekly instead").

## Boundaries

- It can write only inside `agents/`, and run only `deno` — the permission file is the whole story.
- Runs from a checkout today (it drives the repo's CLI). Container packaging for the builder itself is future polish.
