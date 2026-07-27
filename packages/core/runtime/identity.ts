import type { AgentConfig } from "../config/schema.ts";
import type { Provider } from "../providers/types.ts";
import type { Store } from "../store/store.ts";

/** The agent's persistent identity, established on first boot. */
export interface AgentIdentity {
  /** The agent's name. */
  name: string;
  /** True when the naming ritual just happened — the agent's first boot. */
  isNew: boolean;
  /** Where the name came from: set by the operator in config, or self-chosen. */
  source: "config" | "chosen";
}

const NAME_KEY = "name";

// Left to its own devices, every agent independently "chooses" the same
// modal name — famously Nova. Two counters: name the attractors so the
// model steers around them, and hand each birth three random spark words
// so the search starts somewhere different.
const OVERUSED_NAMES = "Nova, Aria, Echo, Sage, Luna, Lyra, Aurora";

const SPARK_WORDS = [
  "amber",
  "basalt",
  "cedar",
  "delta",
  "ember",
  "fjord",
  "garnet",
  "harbor",
  "indigo",
  "juniper",
  "kestrel",
  "lantern",
  "meridian",
  "nimbus",
  "ochre",
  "prism",
  "quartz",
  "reef",
  "saffron",
  "tundra",
  "umber",
  "vellum",
  "willow",
  "zenith",
];

function sparkWords(): string {
  const picks = new Set<string>();
  while (picks.size < 3) {
    picks.add(SPARK_WORDS[Math.floor(Math.random() * SPARK_WORDS.length)]);
  }
  return [...picks].join(", ");
}

// When the model responds but the name is unusable, the agent still gets a
// real name — drawn deterministically from a pool, persisted like any other.
// The pool shares no names with OVERUSED_NAMES; determinism keeps it out of
// the convergence problem, but an agent told to avoid Nova shouldn't be one.
const FALLBACK_NAMES = [
  "Ada",
  "Ember",
  "Helix",
  "Iris",
  "Juno",
  "Möbius",
  "Nyx",
  "Orbit",
  "Piper",
  "Quinn",
  "Rio",
  "Sol",
  "Tess",
  "Vega",
  "Wren",
  "Zephyr",
];

export function pickFallbackName(handle: string): string {
  let hash = 0;
  for (const ch of handle) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
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
 * The naming ritual: by default agents name themselves. Runs once on first
 * boot (one LLM call, routed to the small model role), persists for life in
 * the identity table. If the provider is unreachable the agent temporarily
 * goes by its handle and retries next boot. An operator-set `config.name`
 * skips all of this — it wins over any persisted self-chosen name, but never
 * overwrites it, so removing `name` restores the chosen one.
 */
export async function ensureIdentity(
  config: AgentConfig,
  provider: Provider,
  store: Store,
): Promise<AgentIdentity> {
  if (config.name) return { name: config.name, isNew: false, source: "config" };

  const existing = store.getIdentity(NAME_KEY);
  if (existing) return { name: existing, isNew: false, source: "chosen" };

  let name: string | undefined;
  try {
    const completion = await provider.complete({
      model: config.model.small ?? config.model.id,
      system: "You are a newly created agent choosing your own name — a one-time ritual. " +
        "Pick a short, memorable personal name (one word, or two at most) that suits " +
        "your job. Not a description, not your job title — a name. " +
        `Avoid the names agents before you always reach for: ${OVERUSED_NAMES}. ` +
        "Reply with the name only: no punctuation, no explanation.",
      messages: [{
        role: "user",
        content: `Your job: ${config.description}\n` +
          `Your operator calls you "${config.handle}".\n` +
          `Three spark words, if you want a starting point: ${sparkWords()}.\n` +
          `What is your name?`,
      }],
      maxTokens: 20,
    });
    // Provider responded: this IS the birth. An unusable reply (refusal,
    // sentence, emptiness) falls back to the name pool — still a real name,
    // still persisted, banner still fires.
    name = cleanName(completion.content) ?? pickFallbackName(config.handle);
  } catch {
    // Provider unreachable: no ritual today. Go by the handle, persist
    // nothing, retry next boot.
    return { name: config.handle, isNew: false, source: "chosen" };
  }

  store.setIdentity(NAME_KEY, name);
  return { name, isNew: true, source: "chosen" };
}

/** The identity note appended to the agent's system prompt every run. */
export function identityNote(config: AgentConfig, identity: AgentIdentity): string {
  const origin = identity.source === "config"
    ? "given to you by your operator"
    : "you chose it yourself when you were created";
  return `\n\nYour name is ${identity.name} — ${origin}. ` +
    `Your operator handle is "${config.handle}". Sign off or introduce yourself as ${identity.name} ` +
    `when it's natural to do so.`;
}
