import type { AgentConfig } from "../config/schema.ts";
import type { Provider } from "../providers/types.ts";
import type { ProviderError } from "../providers/types.ts";
import type { Store } from "../store/store.ts";

export interface AgentIdentity {
  /** The agent's self-chosen name. */
  name: string;
  /** True when the naming ritual just happened — the agent's first boot. */
  isNew: boolean;
}

const NAME_KEY = "name";

// When the model responds but the name is unusable, the agent still gets a
// real name — drawn deterministically from a pool, persisted like any other.
const FALLBACK_NAMES = [
  "Ada",
  "Echo",
  "Helix",
  "Iris",
  "Juno",
  "Möbius",
  "Nova",
  "Orbit",
  "Piper",
  "Quinn",
  "Rio",
  "Sage",
  "Tess",
  "Vega",
  "Wren",
  "Zephyr",
];

export function pickFallbackName(nickname: string): string {
  let hash = 0;
  for (const ch of nickname) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return FALLBACK_NAMES[hash % FALLBACK_NAMES.length];
}

/** A usable name: 1–3 words, 2–40 chars, starts with a letter, no sentence. */
function cleanName(raw: string): string | undefined {
  const name = raw.trim().split("\n")[0].replace(/["'.!,:;]/g, "").trim();
  const words = name.split(/\s+/);
  if (name.length < 2 || name.length > 40) return undefined;
  if (words.length > 3) return undefined; // a sentence, not a name
  if (!/^\p{L}/u.test(name)) return undefined;
  return name;
}

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

  let name: string | undefined;
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
    // Provider responded: this IS the birth. An unusable reply (refusal,
    // sentence, emptiness) falls back to the name pool — still a real name,
    // still persisted, banner still fires.
    name = cleanName(completion.content) ?? pickFallbackName(config.nickname);
  } catch {
    // Provider unreachable: no ritual today. Go by the nickname, persist
    // nothing, retry next boot.
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
