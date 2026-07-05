import { assert, assertEquals } from "@std/assert";
import type { Completion, CompletionRequest, Provider } from "../providers/types.ts";
import { ProviderError } from "../providers/types.ts";
import { parseAgentConfig } from "../config/load.ts";
import { Store } from "../store/store.ts";
import { ensureIdentity } from "./identity.ts";

const CONFIG = parseAgentConfig(`
handle: name-bot
description: a test agent
model:
  provider: openai-compatible
  id: big-model
  small: small-model
purpose: test
`);

function namer(reply: string): Provider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    id: "mock",
    requests,
    complete(req: CompletionRequest): Promise<Completion> {
      requests.push(req);
      return Promise.resolve({
        content: reply,
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 10, outputTokens: 2 },
      });
    },
  };
}

Deno.test("naming ritual: happens once, persists, uses the small model role", async () => {
  const store = new Store(":memory:");
  const provider = namer('"Ada."\nextra line');

  const first = await ensureIdentity(CONFIG, provider, store);
  assertEquals(first, { name: "Ada", isNew: true }); // cleaned: quotes/dot/extra line dropped
  assertEquals(provider.requests[0].model, "small-model"); // cheap calls go to the small role

  const second = await ensureIdentity(CONFIG, provider, store);
  assertEquals(second, { name: "Ada", isNew: false });
  assertEquals(provider.requests.length, 1); // no second LLM call, ever
  store.close();
});

Deno.test("naming ritual: the prompt steers away from the modal names", async () => {
  const store = new Store(":memory:");
  const provider = namer("Basalt");
  await ensureIdentity(CONFIG, provider, store);

  const req = provider.requests[0];
  assert(req.system?.includes("Nova")); // the avoid-list names the attractor
  const user = req.messages[0].content as string;
  const words = user.match(/starting point: (.+)\./)?.[1].split(", ") ?? [];
  assertEquals(words.length, 3); // three spark words, all distinct
  assertEquals(new Set(words).size, 3);
  store.close();
});

Deno.test("naming ritual: unusable replies fall back to the name pool, persisted", async () => {
  for (const badReply of ["", "I cannot choose a name for myself as an AI", "!!!"]) {
    const store = new Store(":memory:");
    const identity = await ensureIdentity(CONFIG, namer(badReply), store);
    assert(identity.isNew); // still a birth — the banner fires
    assert(identity.name !== CONFIG.handle, `got handle for reply: "${badReply}"`);
    assert(identity.name.length >= 2);
    assertEquals(store.getIdentity("name"), identity.name); // persisted for life
    store.close();
  }
});

Deno.test("naming ritual: fallback pool is deterministic per handle", async () => {
  const a = new Store(":memory:");
  const b = new Store(":memory:");
  const first = await ensureIdentity(CONFIG, namer(""), a);
  const second = await ensureIdentity(CONFIG, namer(""), b);
  assertEquals(first.name, second.name);
  a.close();
  b.close();
});

Deno.test("naming ritual: provider failure falls back to handle, retries next boot", async () => {
  const store = new Store(":memory:");
  const failing: Provider = {
    id: "mock",
    complete() {
      return Promise.reject(new ProviderError("down", "overloaded"));
    },
  };
  const identity = await ensureIdentity(CONFIG, failing, store);
  assertEquals(identity, { name: "name-bot", isNew: false });
  assertEquals(store.getIdentity("name"), undefined); // nothing persisted — ritual retries

  const recovered = await ensureIdentity(CONFIG, namer("Iris"), store);
  assert(recovered.isNew);
  assertEquals(recovered.name, "Iris");
  store.close();
});
