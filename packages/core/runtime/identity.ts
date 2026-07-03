import type { AgentConfig } from "../config/schema.ts";
import type { Provider } from "../providers/types.ts";
import { ProviderError } from "../providers/types.ts";
import type { Store } from "../store/store.ts";

export interface AgentIdentity {
  /** The agent's self-chosen name. */
  name: string;
  /** True when the naming ritual just happened — the agent's first boot. */
  isNew: boolean;
}

const NAME_KEY = "name";

/**
 * The naming ritual: users don't name agents — agents name themselves.
 * Runs once on first boot (one LLM call, routed to the small model role),
 * persists for life in the identity table. If the provider is unreachable
 * the agent temporarily goes by its nickname and retries next boot.
 */
export async function ensureIdentity(
  config: AgentConfig,
  provider: Provider,
  store: Store,
): Promise<AgentIdentity> {
  const existing = store.getIdentity(NAME_KEY);
  if (existing) return { name: existing, isNew: false };

  let name: string;
  try {
    const completion = await provider.complete({
      model: config.model.small ?? config.model.id,
      system: "You are a newly created agent choosing your own name — a one-time ritual. " +
        "Pick a short, memorable personal name (one word, or two at most) that suits " +
        "your job. Not a description, not your job title — a name. " +
        "Reply with the name only: no punctuation, no explanation.",
      messages: [{
        role: "user",
        content: `Your job: ${config.description}\n` +
          `Your operator calls you "${config.nickname}". What is your name?`,
      }],
      maxTokens: 20,
    });
    name = completion.content.trim().split("\n")[0].replace(/["'.]/g, "").slice(0, 40).trim();
    if (!name) throw new ProviderError("empty name", "unknown");
  } catch {
    // No ritual without a working provider; go by the nickname for now.
    return { name: config.nickname, isNew: false };
  }

  store.setIdentity(NAME_KEY, name);
  return { name, isNew: true };
}

/** The identity note appended to the agent's system prompt every run. */
export function identityNote(config: AgentConfig, name: string): string {
  return `\n\nYour name is ${name} — you chose it yourself when you were created. ` +
    `Your operator handle is "${config.nickname}". Sign off or introduce yourself as ${name} ` +
    `when it's natural to do so.`;
}
