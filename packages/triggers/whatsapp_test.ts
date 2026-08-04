import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { AgentEvent, RunResult } from "@looped/core";
import {
  balanceMarkup,
  inboundMessages,
  memoryState,
  normalizeNumber,
  shouldHandle,
  toWhatsAppMarkup,
  verifyMetaSignature,
  WHATSAPP_LIMIT,
  type WhatsAppMessage,
  WhatsAppTrigger,
  type WhatsAppWebhook,
  windowEndsAt,
} from "./whatsapp.ts";
import { splitMessage } from "./text.ts";

const APP_SECRET = "s3cret";
const PHONE_ID = "123456789012345";
const FROM = "263771234567";

function msg(overrides: Partial<WhatsAppMessage> = {}): WhatsAppMessage {
  return {
    id: "wamid.HBgLMjYzNzcxMjM0NTY3",
    from: FROM,
    timestamp: "1770000000",
    type: "text",
    text: { body: "my order hasn't arrived" },
    ...overrides,
  };
}

/** One delivery, in the entry/changes/value nesting Meta actually sends. */
function webhook(messages: WhatsAppMessage[], field = "messages"): WhatsAppWebhook {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_ID",
      changes: [{
        field,
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "+1 555 0100", phone_number_id: PHONE_ID },
          contacts: [{ profile: { name: "Rudo" }, wa_id: FROM }],
          messages,
        },
      }],
    }],
  };
}

async function sign(body: string, secret = APP_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("verifyMetaSignature: accepts the real digest, rejects everything else", async () => {
  const body = new TextEncoder().encode('{"object":"whatsapp_business_account"}');
  const signature = await sign(new TextDecoder().decode(body));
  assert(await verifyMetaSignature({ appSecret: APP_SECRET, signature, body }));
  assert(!await verifyMetaSignature({ appSecret: "wrong", signature, body }));
  assert(!await verifyMetaSignature({ appSecret: APP_SECRET, signature: "sha256=00", body }));
  assert(!await verifyMetaSignature({ appSecret: APP_SECRET, signature: "", body }));
  // The digest is over the exact bytes: one character of whitespace breaks it,
  // which is why the verifier never sees a parsed object.
  const reserialized = new TextEncoder().encode('{"object": "whatsapp_business_account"}');
  assert(!await verifyMetaSignature({ appSecret: APP_SECRET, signature, body: reserialized }));
});

Deno.test("shouldHandle: text and media wake the agent, unsupported types do not", () => {
  assert(shouldHandle(msg()));
  assert(shouldHandle(msg({ type: "image", text: undefined, image: { id: "m1" } })));
  assert(shouldHandle(msg({ type: "audio", text: undefined, audio: { id: "m2", voice: true } })));
  assert(!shouldHandle(msg({ type: "text", text: { body: "   " } })));
  assert(!shouldHandle(msg({ type: "location", text: undefined })));
  assert(!shouldHandle(msg({ id: "" })));
  assert(!shouldHandle(msg({ from: "" })));
});

Deno.test("shouldHandle: from_numbers compares digits only", () => {
  assert(shouldHandle(msg(), ["+263 77 123 4567"]));
  assert(shouldHandle(msg(), ["263771234567"]));
  assert(!shouldHandle(msg(), ["+263779999999"]));
  // an empty list behaves like no filter
  assert(shouldHandle(msg(), []));
  assertEquals(normalizeNumber("+263 (77) 123-4567"), "263771234567");
});

Deno.test("inboundMessages: flattens entry/changes and ignores other fields", () => {
  assertEquals(inboundMessages(webhook([msg()])).length, 1);
  assertEquals(inboundMessages(webhook([msg(), msg({ id: "wamid.2" })])).length, 2);
  // A delivery-receipt-only change carries no messages.
  assertEquals(inboundMessages(webhook([], "messages")).length, 0);
  // Another field on the same subscription is not ours.
  assertEquals(inboundMessages(webhook([msg()], "account_update")).length, 0);
  assertEquals(inboundMessages({}).length, 0);
});

Deno.test("windowEndsAt: 24 hours normally, 72 from a free entry point", () => {
  const now = 1_770_000_000_000;
  const hour = 60 * 60 * 1000;
  assertEquals(windowEndsAt(msg({ timestamp: String(now / 1000) }), now), now + 24 * hour);
  assertEquals(
    windowEndsAt(msg({ timestamp: String(now / 1000), referral: { source_type: "ad" } }), now),
    now + 72 * hour,
  );
  // A retried delivery stamped in the future is not allowed to extend the
  // window past what our own clock says.
  assertEquals(windowEndsAt(msg({ timestamp: String(now / 1000 + 9999) }), now), now + 24 * hour);
  assertEquals(windowEndsAt(msg({ timestamp: undefined }), now), now + 24 * hour);
});

Deno.test("memoryState: a wamid is claimed once", () => {
  const state = memoryState();
  assert(state.claim("wamid.1"));
  assert(!state.claim("wamid.1"));
  assert(state.claim("wamid.2"));
  assertEquals(state.windowEndsAt("263771234567"), undefined);
  state.setWindowEndsAt("263771234567", 42);
  assertEquals(state.windowEndsAt("263771234567"), 42);
});

Deno.test("toWhatsAppMarkup: markdown becomes WhatsApp's own markup", () => {
  assertEquals(toWhatsAppMarkup("**bold** and __also bold__"), "*bold* and *also bold*");
  assertEquals(toWhatsAppMarkup("# Order status"), "*Order status*");
  assertEquals(toWhatsAppMarkup("### Deep heading ###"), "*Deep heading*");
  assertEquals(toWhatsAppMarkup("[the docs](https://looped.dev)"), "the docs (https://looped.dev)");
  assertEquals(toWhatsAppMarkup("~~gone~~"), "~gone~");
  assertEquals(toWhatsAppMarkup("* first\n* second"), "- first\n- second");
  assertEquals(toWhatsAppMarkup("_italic_ stays"), "_italic_ stays");
  assertEquals(toWhatsAppMarkup("*already bold*"), "*already bold*");
  // Verbatim regions are the agent quoting something; leave them alone.
  assertEquals(toWhatsAppMarkup("```\n**not bold**\n```"), "```\n**not bold**\n```");
  assertEquals(toWhatsAppMarkup("`**x**`"), "`**x**`");
  // Arithmetic and stray asterisks are not emphasis.
  assertEquals(toWhatsAppMarkup("2 * 3 * 4"), "2 * 3 * 4");
});

Deno.test("toWhatsAppMarkup: a heading keeps markup it already carries", () => {
  // Wrapping a body that already has a bold run in another pair of asterisks
  // produced "**Q3 results* are in*", which renders as neither.
  assertEquals(toWhatsAppMarkup("# **Q3 results** are in"), "*Q3 results* are in");
  assertEquals(toWhatsAppMarkup("## **Warning**"), "*Warning*");
  assertEquals(toWhatsAppMarkup("# __Q3__ results"), "*Q3* results");
});

Deno.test("toWhatsAppMarkup: an unpaired marker cannot bold the rest of the message", () => {
  // A stray "**" used to pair with the next legitimate one, bolding every
  // paragraph in between.
  assertEquals(
    toWhatsAppMarkup("Rating: **4/5\nSome text.\nTotal: 9 **out of 10**"),
    "Rating: **4/5\nSome text.\nTotal: 9 *out of 10*",
  );
  assertEquals(toWhatsAppMarkup("**Note:\n\nstill fine** ok"), "**Note:\n\nstill fine** ok");
});

Deno.test("toWhatsAppMarkup: an unterminated fence is still verbatim", () => {
  // What a reply truncated at max tokens looks like.
  assertEquals(
    toWhatsAppMarkup("```\nconst x = **y**;\nno closing fence"),
    "```\nconst x = **y**;\nno closing fence",
  );
});

Deno.test("toWhatsAppMarkup: an unclosed link does not stall the event loop", () => {
  // The url run used to backtrack across the whole message from every start
  // position: 200 KB of "[a](b" took 13 seconds with the listener blocked.
  const hostile = "[a](b".repeat(40_000);
  const started = performance.now();
  toWhatsAppMarkup(hostile);
  const elapsed = performance.now() - started;
  assert(elapsed < 1_000, `took ${elapsed.toFixed(0)}ms`);
});

Deno.test("balanceMarkup: a split never leaves a run hanging", () => {
  assertEquals(balanceMarkup(["a *bold", "text* b"]), ["a *bold*", "*text* b"]);
  assertEquals(balanceMarkup(["_i", "t_"]), ["_i_", "_t_"]);
  assertEquals(balanceMarkup(["~s", "t~"]), ["~s~", "~t~"]);
  // A torn fence is the worst case: a raw fence in one message and
  // unformatted code in the next.
  assertEquals(balanceMarkup(["```\ncode", "more\n```"]), ["```\ncode\n```", "```\nmore\n```"]);
  // Balanced parts are left exactly as they are.
  assertEquals(balanceMarkup(["*a* b", "c *d*"]), ["*a* b", "c *d*"]);
  // A marker inside code is not a run that needs closing.
  assertEquals(balanceMarkup(["`a*b`", "c"]), ["`a*b`", "c"]);
  assertEquals(balanceMarkup(["only one"]), ["only one"]);
});

Deno.test("memoryState: a wamid can be handed back after a failed run", () => {
  const state = memoryState();
  assert(state.claim("wamid.1"));
  assert(!state.claim("wamid.1"));
  state.release("wamid.1");
  assert(state.claim("wamid.1"));
});

Deno.test("splitMessage: 4096 is WhatsApp's hard cap", () => {
  const long = "x".repeat(WHATSAPP_LIMIT * 2 + 5);
  const parts = splitMessage(long, WHATSAPP_LIMIT);
  assertEquals(parts.length, 3);
  assert(parts.every((p) => p.length <= WHATSAPP_LIMIT));
  assertEquals(parts.join("").length, long.length);
  assertEquals(splitMessage("x".repeat(WHATSAPP_LIMIT), WHATSAPP_LIMIT).length, 1);
});

/** A fake Graph API: records sends, answers the phone-number and media lookups. */
function fakeGraph(opts: { mediaBytes?: number; declaredSize?: number } = {}) {
  const sends: Record<string, unknown>[] = [];
  let bytesServed = 0;
  let port = 0;
  const server = Deno.serve({ port: 0, onListen: (a) => port = a.port }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === `/v26.0/${PHONE_ID}`) {
      return Response.json({ display_phone_number: "+1 555 0100", id: PHONE_ID });
    }
    if (req.method === "POST" && url.pathname === `/v26.0/${PHONE_ID}/messages`) {
      sends.push(await req.json());
      return Response.json({ messages: [{ id: "wamid.sent" }] });
    }
    // The media lookup: an id resolves to a signed url on another host.
    if (req.method === "GET" && url.pathname === "/v26.0/987654321") {
      return Response.json({
        url: `http://127.0.0.1:${port}/media-bytes`,
        mime_type: "image/png",
        ...(opts.declaredSize === undefined ? {} : { file_size: opts.declaredSize }),
      });
    }
    if (url.pathname === "/media-bytes") {
      const size = opts.mediaBytes ?? 0;
      bytesServed += size;
      return new Response(new Uint8Array(size), { headers: { "content-type": "image/png" } });
    }
    return Response.json({ error: { message: "unexpected call" } }, { status: 404 });
  });
  return {
    sends,
    server,
    bytesServed: () => bytesServed,
    base: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
  };
}

/** A trigger wired to a fake Graph, listening on an ephemeral port. */
async function standUp(
  emit: (event: AgentEvent) => Promise<RunResult>,
  opts: {
    fromNumbers?: string[];
    outOfWindowTemplate?: string;
    media?: { maxImageBytes: number; maxImagesPerMessage: number };
  } = {},
  graphOpts: { mediaBytes?: number; declaredSize?: number } = {},
) {
  const graph = fakeGraph(graphOpts);
  let port = 0;
  const trigger = new WhatsAppTrigger({
    phoneNumberId: PHONE_ID,
    token: "EAAG...",
    appSecret: APP_SECRET,
    verifyToken: "hunter2",
    apiBase: graph.base,
    port: 0,
    onListen: (addr) => port = addr.port,
    ...opts,
  });
  await trigger.start(emit);
  return {
    trigger,
    sends: graph.sends,
    bytesServed: graph.bytesServed,
    url: `http://127.0.0.1:${port}/whatsapp`,
    async close() {
      await trigger.stop();
      await graph.server.shutdown();
    },
  };
}

/** Wait for a condition the dispatched (un-awaited) run will satisfy. */
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function post(url: string, payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  return await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature ?? await sign(body),
    },
    body,
  });
}

Deno.test("whatsapp: the GET handshake echoes the challenge for the right token only", async () => {
  const app = await standUp(() => Promise.resolve({ status: "ok", reply: "hi" } as RunResult));
  try {
    const ok = await fetch(
      `${app.url}?hub.mode=subscribe&hub.verify_token=hunter2&hub.challenge=1158201444`,
    );
    assertEquals(ok.status, 200);
    assertEquals(await ok.text(), "1158201444");

    const wrong = await fetch(
      `${app.url}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1158201444`,
    );
    assertEquals(wrong.status, 403);
    await wrong.body?.cancel();
  } finally {
    await app.close();
  }
});

Deno.test("whatsapp: a signed delivery wakes the agent and replies to the sender", async () => {
  const events: AgentEvent[] = [];
  const app = await standUp((event) => {
    events.push(event);
    return Promise.resolve({ status: "ok", reply: "**On its way** — tracking below" } as RunResult);
  });
  try {
    const res = await post(app.url, webhook([msg()]));
    assertEquals(res.status, 200);
    await res.body?.cancel();

    await until(() => app.sends.length === 1, "the reply");
    assertEquals(events.length, 1);
    assertEquals(events[0].input, "my order hasn't arrived");
    assertEquals(events[0].conversationKey, `whatsapp:${FROM}`);
    assertEquals(events[0].trigger, "whatsapp");

    const sent = app.sends[0] as Record<string, string | Record<string, string>>;
    assertEquals(sent.messaging_product, "whatsapp");
    assertEquals(sent.to, FROM);
    assertEquals(sent.type, "text");
    // Markdown the model learned elsewhere is converted, not sent literally.
    assertEquals(
      (sent.text as Record<string, string>).body,
      "*On its way* — tracking below",
    );
  } finally {
    await app.close();
  }
});

Deno.test("whatsapp: an unsigned or wrongly signed delivery never reaches the parser", async () => {
  let woken = false;
  const app = await standUp(() => {
    woken = true;
    return Promise.resolve({ status: "ok", reply: "hi" } as RunResult);
  });
  try {
    const unsigned = await fetch(app.url, { method: "POST", body: "{}" });
    assertEquals(unsigned.status, 401);
    await unsigned.body?.cancel();

    const bad = await post(app.url, webhook([msg()]), await sign("{}", "not-the-secret"));
    assertEquals(bad.status, 401);
    await bad.body?.cancel();

    assert(!woken);
    assertEquals(app.sends.length, 0);
  } finally {
    await app.close();
  }
});

Deno.test("whatsapp: a retried delivery of the same wamid runs once", async () => {
  let runs = 0;
  const app = await standUp(() => {
    runs++;
    return Promise.resolve({ status: "ok", reply: "ack" } as RunResult);
  });
  try {
    const payload = webhook([msg()]);
    (await post(app.url, payload)).body?.cancel();
    await until(() => app.sends.length === 1, "the first reply");
    // Meta retries for days, unordered, and fans out to every subscribed app.
    (await post(app.url, payload)).body?.cancel();
    (await post(app.url, payload)).body?.cancel();
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(runs, 1);
    assertEquals(app.sends.length, 1);
  } finally {
    await app.close();
  }
});

Deno.test("whatsapp: from_numbers drops a stranger before the model is called", async () => {
  let woken = false;
  const app = await standUp(() => {
    woken = true;
    return Promise.resolve({ status: "ok", reply: "hi" } as RunResult);
  }, { fromNumbers: ["+263779999999"] });
  try {
    (await post(app.url, webhook([msg()]))).body?.cancel();
    await new Promise((r) => setTimeout(r, 100));
    assert(!woken);
    assertEquals(app.sends.length, 0);
  } finally {
    await app.close();
  }
});

Deno.test("whatsapp: deliver sends inside the window and refuses outside it", async () => {
  const app = await standUp(() => Promise.resolve({ status: "ok", reply: "ack" } as RunResult));
  try {
    // Nothing inbound yet: no window was ever opened.
    await assertRejects(
      () => app.trigger.deliver(`whatsapp:${FROM}`, "your order shipped"),
      Error,
      "service window",
    );
    // Another channel's key is not ours.
    assertEquals(await app.trigger.deliver("telegram:99", "hi"), false);

    // An inbound message opens the window; the scheduled send now lands.
    (await post(app.url, webhook([msg({ timestamp: String(Date.now() / 1000 | 0) })]))).body
      ?.cancel();
    await until(() => app.sends.length === 1, "the reply");
    assertEquals(await app.trigger.deliver(`whatsapp:${FROM}`, "your order shipped"), true);
    await until(() => app.sends.length === 2, "the scheduled send");
    assertEquals(
      (app.sends[1] as Record<string, Record<string, string>>).text.body,
      "your order shipped",
    );
  } finally {
    await app.close();
  }
});

Deno.test("whatsapp: an approved template carries an out-of-window send", async () => {
  const app = await standUp(
    () => Promise.resolve({ status: "ok", reply: "ack" } as RunResult),
    { outOfWindowTemplate: "service_update" },
  );
  try {
    assertEquals(await app.trigger.deliver(`whatsapp:${FROM}`, "your order shipped"), true);
    assertEquals(app.sends.length, 1);
    const sent = app.sends[0] as Record<string, string | Record<string, unknown>>;
    assertEquals(sent.type, "template");
    const template = sent.template as Record<string, unknown>;
    assertEquals(template.name, "service_update");
    assertEquals((template.language as Record<string, string>).code, "en_US");
    assertStringIncludes(JSON.stringify(template.components), "your order shipped");
  } finally {
    await app.close();
  }
});

/** A document keeps its real mime type, so an image sent "as a file" looks like an image. */
function imageAsDocument(): WhatsAppMessage {
  return msg({
    type: "document",
    text: undefined,
    document: { id: "987654321", mime_type: "image/png", filename: "invoice.png" },
  });
}

Deno.test("whatsapp: an oversized image is refused before its bytes are downloaded", async () => {
  const events: AgentEvent[] = [];
  // WhatsApp allows a 100 MB document, and a document with an image mime type
  // reaches the image path. The size never rides on the webhook, so without a
  // ceiling on the fetch itself the whole file lands in memory and is only
  // then measured against max_image_bytes.
  const app = await standUp(
    (event) => {
      events.push(event);
      return Promise.resolve({ status: "ok", reply: "seen" } as RunResult);
    },
    { media: { maxImageBytes: 1_000, maxImagesPerMessage: 4 } },
    { mediaBytes: 40_000, declaredSize: 40_000 },
  );
  try {
    (await post(app.url, webhook([imageAsDocument()]))).body?.cancel();
    await until(() => events.length === 1, "the run");
    // Graph declared the size, so the refusal cost nothing: the bytes were
    // never requested.
    assertEquals(app.bytesServed(), 0);
    assertEquals(events[0].images ?? [], []);
    // The refusal came from the download, not from the resolver measuring
    // bytes it had already accepted.
    assertStringIncludes(events[0].input, "invoice.png");
    assertStringIncludes(events[0].input, "40000 bytes, over the 1000 limit");
  } finally {
    await app.close();
  }
});

Deno.test("whatsapp: a lying file_size is still capped at the read", async () => {
  const events: AgentEvent[] = [];
  // file_size is Graph's claim. When it is absent or wrong, the byte counter
  // on the stream is what actually holds the line.
  const app = await standUp(
    (event) => {
      events.push(event);
      return Promise.resolve({ status: "ok", reply: "seen" } as RunResult);
    },
    { media: { maxImageBytes: 1_000, maxImagesPerMessage: 4 } },
    { mediaBytes: 40_000 }, // no declaredSize
  );
  try {
    (await post(app.url, webhook([imageAsDocument()]))).body?.cancel();
    await until(() => events.length === 1, "the run");
    assertEquals(events[0].images ?? [], []);
    assertStringIncludes(events[0].input, "invoice.png");
    // "over the 1000 limit" is the read refusing mid-stream. The resolver's
    // own after-the-fact check reads "over the 977 B image limit" instead, so
    // this asserts the bytes were never fully accepted.
    assertStringIncludes(events[0].input, "over the 1000 limit");
  } finally {
    await app.close();
  }
});

Deno.test("whatsapp: an oversized body is refused before the signature is checked", async () => {
  let woken = false;
  const app = await standUp(() => {
    woken = true;
    return Promise.resolve({ status: "ok", reply: "hi" } as RunResult);
  });
  try {
    // Anyone can POST here; the body has to be read before it can be verified,
    // so the read is what needs the ceiling.
    const huge = "x".repeat(2_000_000);
    const res = await fetch(app.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": await sign(huge) },
      body: huge,
    });
    assertEquals(res.status, 413);
    await res.body?.cancel();
    assert(!woken);
  } finally {
    await app.close();
  }
});

Deno.test("whatsapp: a failed run hands the wamid back so the next copy is handled", async () => {
  let calls = 0;
  const app = await standUp(() => {
    calls++;
    if (calls === 1) return Promise.reject(new Error("the store was busy"));
    return Promise.resolve({ status: "ok", reply: "second time lucky" } as RunResult);
  });
  try {
    const payload = webhook([msg()]);
    (await post(app.url, payload)).body?.cancel();
    await until(() => calls === 1, "the failed run");
    // Meta delivers at-least-once even after a 200. Without the release, this
    // copy is dropped as a duplicate and the message is lost for good.
    (await post(app.url, payload)).body?.cancel();
    await until(() => app.sends.length === 1, "the reply from the retry");
    assertEquals(calls, 2);
  } finally {
    await app.close();
  }
});

Deno.test("whatsapp: stop() waits for a run the webhook already acked", async () => {
  let finished = false;
  const app = await standUp(async () => {
    await new Promise((r) => setTimeout(r, 150));
    finished = true;
    return { status: "ok", reply: "done" } as RunResult;
  });
  (await post(app.url, webhook([msg()]))).body?.cancel();
  await until(() => !finished, "the run to start");
  // The delivery was acked on arrival, so abandoning the run here would be a
  // message accepted and never answered.
  await app.close();
  assert(finished, "stop() returned while a run was still in flight");
});
