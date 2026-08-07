# @looped/triggers

Event sources for [Looped AF](https://github.com/loopedautomation/agent-framework) agents. A trigger connects outward, turns what it hears into events and carries the agent's reply back. This package ships several: Discord and Slack over their real-time gateways, Telegram over Bot API long-polling, WhatsApp over the Cloud API webhook, email over four transports, GitHub webhooks, an authenticated webhook server and a cron schedule. Slack and Telegram also take an inbound-HTTP transport (`events_api` / `webhook`) for scale-to-zero hosts; WhatsApp is inbound-HTTP only, because the Cloud API offers nothing else.

```ts
import { AgentService, loadAgentConfig } from "@looped/core";
import { triggersFromConfig } from "@looped/triggers";

const config = await loadAgentConfig("./agent.yaml");
const service = new AgentService({ config });
await service.init();
await service.start(triggersFromConfig(config));
```

`triggersFromConfig` builds whatever the config's `triggers` block declares, and it resolves bot tokens from env vars at startup, so a missing secret fails before the first event arrives. You can also construct a trigger directly:

```ts
import { CronTrigger } from "@looped/triggers";

const weekly = new CronTrigger({
  schedule: "0 9 * * 1",
  prompt: "Write the weekly summary and post it.",
});
```

Each trigger implements the small `Trigger` interface from `@looped/core` (`start`, `stop`, a name), so writing your own event source means implementing three members.

Docs: [docs.looped.sh/agent-framework/triggers](https://docs.looped.sh/agent-framework/triggers)
