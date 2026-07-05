# Examples

Complete, runnable agents. Each one is a copy-paste starting point that demonstrates one thing, and CI runs them, so they double as executable documentation.

- [`time-bot`](time-bot/) - the minimal agent: identity, model, purpose. No triggers, so `af run` is a REPL.
- [`echo-service`](echo-service/) - a webhook-triggered service that may run `echo` and nothing else. Ask it to `curl` something and read the denial in the reply, then find the same denial in the audit table.
- [`weather-bot`](weather-bot/) - a Telegram bot that can reach wttr.in and nothing else. The fastest one to get running: a BotFather token and two env vars.
- [`standup-watcher`](standup-watcher/) - a Slack observer: it watches the standup channel, nudges updates that are missing a plan or blockers and stays silent otherwise (`allow_silence`).
- [`gh-issues-cli`](gh-issues-cli/) - the flagship: Discord to GitHub issues. A skill teaching the `gh` CLI, scoped permissions and secrets, a custom Dockerfile and a compose file, deployed with `docker compose up`.
- [`gh-issues-mcp`](gh-issues-mcp/) - the same agent with its GitHub tools coming from the official GitHub MCP server. Read it next to `gh-issues-cli` to compare the two ways of giving an agent a capability.
- [`agent-zero`](agent-zero/) - the agent that builds agents: describe an agent in one Discord message, receive a scaffolded, validated project. It drives `af init` rather than hand-writing boilerplate.
