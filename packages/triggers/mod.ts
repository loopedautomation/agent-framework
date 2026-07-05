/**
 * Event sources that wake a Looped AF agent - Discord, Slack, Telegram,
 * webhook and cron - plus {@linkcode triggersFromConfig} to build them
 * from an agent config.
 *
 * @module
 */

import type { AgentConfig, Trigger } from "@looped/core";
import { WebhookTrigger } from "./webhook.ts";
import { CronTrigger } from "./cron.ts";
import { DiscordTrigger } from "./discord.ts";
import { SlackTrigger } from "./slack.ts";
import { TelegramTrigger } from "./telegram.ts";

export type {
  AgentConfig,
  AgentEvent,
  CronTriggerConfig,
  DiscordTriggerConfig,
  LimitsConfig,
  McpServerConfig,
  MemoryConfig,
  Message,
  ModelConfig,
  Permissions,
  RunResult,
  RunStatus,
  SlackTriggerConfig,
  TelegramTriggerConfig,
  ToolCall,
  Trigger,
  TriggerConfig,
  Usage,
  WebhookTriggerConfig,
} from "@looped/core";
export { NO_REPLY } from "./text.ts";
export { CronTrigger, type CronTriggerOptions } from "./cron.ts";
export { WebhookTrigger, type WebhookTriggerOptions } from "./webhook.ts";
export {
  type DiscordFilterOptions,
  DiscordTrigger,
  type DiscordTriggerOptions,
  fetchApplicationId,
  INVITE_PERMISSIONS,
  inviteUrl,
} from "./discord.ts";
export { type SlackFilterOptions, SlackTrigger, type SlackTriggerOptions } from "./slack.ts";
export {
  type TelegramFilterOptions,
  TelegramTrigger,
  type TelegramTriggerOptions,
} from "./telegram.ts";

/**
 * Instantiate the triggers a config declares.
 * Tokens resolve from *_env here — startup, not first request.
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
      case "slack": {
        const token = getEnv(t.token_env);
        if (!token) {
          throw new Error(`slack trigger: bot token env var ${t.token_env} is not set`);
        }
        const appToken = getEnv(t.app_token_env);
        if (!appToken) {
          throw new Error(
            `slack trigger: app-level token env var ${t.app_token_env} is not set (Socket Mode needs it)`,
          );
        }
        triggers.push(
          new SlackTrigger({
            token,
            appToken,
            channels: t.channels,
            requireMention: t.require_mention,
            fromUsers: t.from_users,
            replyChannel: t.reply_channel,
            allowSilence: t.allow_silence,
          }),
        );
        break;
      }
      case "telegram": {
        const token = getEnv(t.token_env);
        if (!token) {
          throw new Error(`telegram trigger: bot token env var ${t.token_env} is not set`);
        }
        triggers.push(
          new TelegramTrigger({
            token,
            chats: t.chats,
            requireMention: t.require_mention,
            fromUsers: t.from_users,
            replyChat: t.reply_chat,
            allowSilence: t.allow_silence,
          }),
        );
        break;
      }
    }
  }
  return triggers;
}
