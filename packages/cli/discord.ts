// af discord-invite — print the bot's OAuth invite URL (no bitfield math).

import { resolveAgentConfig } from "@looped/core";
import { fetchApplicationId, inviteUrl } from "@looped/triggers";
import { dim } from "./style.ts";
import { fail } from "./docker_commands.ts";

export async function discordInvite(path: string) {
  const config = await resolveAgentConfig(path);
  const trigger = config.triggers?.find((t) => t.type === "discord");
  if (!trigger || trigger.type !== "discord") {
    fail(`${path} has no discord trigger`);
  }
  const token = Deno.env.get(trigger.token_env);
  if (!token) {
    fail(
      `${trigger.token_env} is not set — the invite URL needs the bot token to look up the app id`,
    );
  }
  const appId = await fetchApplicationId(token);
  console.log(inviteUrl(appId));
  console.log(
    dim(
      "open this URL to invite the bot (grants: View Channels, Send Messages, Read Message History)",
    ),
  );
}
