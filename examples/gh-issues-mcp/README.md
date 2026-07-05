# Deploying gh-issues-mcp

The same agent as [`gh-issues-cli`](../gh-issues-cli/): a Discord bot that turns messages in `#issues` into GitHub issues and replies with the link. The difference is where the GitHub tools come from. Here the agent talks to the official [GitHub MCP server](https://github.com/github/github-mcp-server), which the Dockerfile installs and the `tools.mcp` block wires up; over in `gh-issues-cli` the same layer installs the `gh` CLI and a [skill](../../skills/gh-issues.md) teaches the agent how to use it.

## Which one should you pick?

For most integrations, you don't need an MCP server. A CLI and a well written skill can go a long way, and they cost the model almost no context. Reach for the MCP server when there is a good official one (GitHub's is), when you'd rather get typed tools than teach a CLI, or when there is no CLI to install in the first place. The cost is context: every exposed tool puts its schema in front of the model on every turn, which is why this example's `include:` list cuts the server's roughly one hundred tools down to the five the job needs.

## Setup

The prerequisites and the Discord setup are identical to gh-issues-cli, so follow [steps 1-3 of its README](../gh-issues-cli/README.md) (Discord bot with Message Content Intent, fine-grained GitHub PAT with Issues read/write, repo name in the `purpose`) and come back. One difference on the token: the MCP server reads it as `GITHUB_PERSONAL_ACCESS_TOKEN`, and the `env:` block in `agent.yaml` maps your `GITHUB_TOKEN` onto that name, so `.env` stays the same across both examples.

Then, in this directory:

```sh
cp .env.example .env     # fill in the three values; never commit .env
docker compose up -d --build
```

The build downloads the `github-mcp-server` binary from its GitHub release (version pinned by `MCP_VERSION` in the Dockerfile) and bakes it into the image next to the config.

## Verify

```sh
docker compose ps                      # should say "healthy" after ~15s
curl -s localhost:9091/healthz        # identity JSON - note the agent's chosen name
docker compose logs -f                # watch it connect to Discord
```

The host port is 9091 so this example can run next to gh-issues-cli. Post in `#issues`:

> the CSV export breaks on files over 10MB, probably the streaming parser

You should get a reply with a GitHub issue link within seconds. In the audit trail (`curl -s localhost:9091/runs`) the tool call shows up as `mcp__github__issue_write`; that namespacing is how MCP tools appear everywhere in the framework.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Bot online but never replies | Message Content Intent not enabled - the #1 failure mode |
| `discord: cannot reach gateway (401)` in logs | Bad `DISCORD_BOT_TOKEN` |
| Container exits at startup with an MCP connect error | The server binary failed to launch; check `docker compose logs` and rebuild |
| Replies with a GitHub permission error | PAT lacks Issues write on the repo, or wrong repo in the prompt |
| `error_provider (auth)` in replies | Bad `OPENAI_API_KEY` |

The agent's memory, run history and audit log live in the `gh-issues-mcp-data` Docker volume; deleting that volume gives it a fresh memory (and it will choose a new name for itself).
