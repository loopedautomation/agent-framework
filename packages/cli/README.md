# @looped/af

`af` is the [Looped AF](https://github.com/loopedautomation/agent-framework) command line: a Docker frontend for agents defined as a single YAML file. It scaffolds a project, validates the file and runs the agent inside the published container image, so nothing executes on your host.

Install it once with Deno:

```sh
deno install -g --allow-read --allow-write --allow-env --allow-net --allow-run=bash,docker,deno -n af jsr:@looped/af
```

Then, from an empty directory:

```sh
af init issue-bot   # scaffold the project: agent.yaml, secrets template, deployment shape
af validate         # check the file and report which env vars it references
af run              # run it in Docker; a REPL without triggers, a service with them
```

`af up -d` starts one or more agents in the background, `af ps` lists them and `af down` stops them. Run `af update` to reinstall the CLI at the latest published version. The full command reference lives at [docs.looped.sh/agent-framework/cli](https://docs.looped.sh/agent-framework/cli).
