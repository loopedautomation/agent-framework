# @looped/core

The runtime for [Looped AF](https://github.com/loopedautomation/agent-framework) agents: the agent loop, the config loader, the model providers, the permission engine, the native tools, skills and the SQLite store. The `af` CLI and the published container image are thin layers over this package, so if you want to embed an agent in your own Deno program, this is the piece you import.

```ts
import { AgentService, loadAgentConfig } from "@looped/core";

const config = await loadAgentConfig("./agent.yaml");
const service = new AgentService({ config });
await service.init();

const result = await service.handle({
  id: crypto.randomUUID(),
  trigger: "cli",
  input: "What time is it in Tokyo?",
});
console.log(result.reply);
```

`AgentService` is the outer loop. It waits for events, assembles context, runs the model in a tool-use loop and records every run and permission decision in SQLite. Pair it with [@looped/triggers](https://jsr.io/@looped/triggers) to wake it from a Discord message, a webhook or a cron tick; without triggers you call `handle` yourself, as above.

For most agents you don't need this package directly. `af run` (from [@looped/af](https://jsr.io/@looped/af)) starts the same service inside the published container image, with the config's permissions compiled down to Deno flags. Reach for `@looped/core` when you're building your own runtime around it.

Docs: [docs.looped.sh/agent-framework](https://docs.looped.sh/agent-framework)
