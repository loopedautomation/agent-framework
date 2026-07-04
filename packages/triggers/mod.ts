// @looped/triggers — event sources for Looped agents.

import type { AgentConfig, Trigger } from "@looped/core";
import { WebhookTrigger } from "./webhook.ts";
import { CronTrigger } from "./cron.ts";
import { DiscordTrigger } from "./discord.ts";

export { CronTrigger, type CronTriggerOptions } from "./cron.ts";
export { WebhookTrigger, type WebhookTriggerOptions } from "./webhook.ts";
export {
  DiscordTrigger,
  type DiscordTriggerOptions,
  fetchApplicationId,
  INVITE_PERMISSIONS,
  inviteUrl,
  NO_REPLY,
} from "./discord.ts";

/**
 * Instantiate the triggers a config declares. Discord arrives in M3.
 * Webhook tokens resolve from token_env here — startup, not first request.
 */
export function triggersFromConfig(
  config: AgentConfig,
  getEnv: (name: string) => string | undefined = Deno.env.get,
): Trigger[] {
  const triggers: Trigger[] = [];
  for (const t of config.triggers ?? []) {
    switch (t.type) {
      case "webhook": {
        const token = getEnv(t.token_env);
        if (!token) {
          throw new Error(
            `webhook trigger: token env var ${t.token_env} is not set (required for bearer auth)`,
          );
        }
        triggers.push(new WebhookTrigger({ path: t.path, port: t.port, token }));
        break;
      }
      case "cron":
        triggers.push(new CronTrigger({ schedule: t.schedule, prompt: t.prompt }));
        break;
      case "discord": {
        const token = getEnv(t.token_env);
        if (!token) {
          throw new Error(
            `discord trigger: bot token env var ${t.token_env} is not set`,
          );
        }
        triggers.push(
          new DiscordTrigger({
            token,
            channels: t.channels,
            requireMention: t.require_mention,
            fromUsers: t.from_users,
            replyChannel: t.reply_channel,
            allowSilence: t.allow_silence,
          }),
        );
        break;
      }
    }
  }
  return triggers;
}
