import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { WhatsAppTrigger } from "./whatsapp.ts";
import type { AgentEvent, RunResult } from "@looped/core";

// A live check against a real WhatsApp Business Account. Skipped unless the
// credentials are present, so it never runs in CI — the point is that the
// handshake and the first send are exactly the steps docs/whatsapp.mdx can
// describe wrongly for a year without anyone noticing.
//
//   WHATSAPP_TOKEN=...            a system user token
//   WHATSAPP_PHONE_NUMBER_ID=...  from the WhatsApp Manager
//   WHATSAPP_APP_SECRET=...       App Dashboard → Settings → Basic
//   WHATSAPP_TEST_RECIPIENT=...   a number on your test-recipient list, digits only
//
// The send only works if that recipient has messaged your number in the last
// 24 hours: outside the service window Graph refuses free-form text, which is
// the behaviour the trigger reproduces rather than papers over.

const token = Deno.env.get("WHATSAPP_TOKEN");
const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
const appSecret = Deno.env.get("WHATSAPP_APP_SECRET") ?? "unused-for-outbound";
const recipient = Deno.env.get("WHATSAPP_TEST_RECIPIENT");
const live = Boolean(token && phoneNumberId);

function trigger(opts: Record<string, unknown> = {}) {
  return new WhatsAppTrigger({
    phoneNumberId: phoneNumberId!,
    token: token!,
    appSecret,
    verifyToken: "live-test-" + phoneNumberId,
    port: 0,
    onListen: () => {},
    ...opts,
  });
}

const noop = () => Promise.resolve({ status: "ok", reply: "" } as RunResult);

Deno.test({
  name: "live: the credentials resolve to a real phone number",
  ignore: !live,
  async fn() {
    const t = trigger();
    // start() reads the number back through Graph: a bad token or a bad
    // phone_number_id fails here, at boot, with the reason attached.
    await t.start(noop as (e: AgentEvent) => Promise<RunResult>);
    await t.stop();
  },
});

Deno.test({
  name: "live: a bad token fails at boot rather than at 3am",
  ignore: !live,
  async fn() {
    const t = trigger({ token: "EAAnot-a-real-token" });
    const err = await t.start(noop as (e: AgentEvent) => Promise<RunResult>)
      .then(() => undefined, (e: Error) => e);
    await t.stop();
    assert(err, "a bad token should have thrown");
    assertStringIncludes(err.message, "check phone_number_id and the access token");
  },
});

Deno.test({
  name: "live: a text message reaches a real handset",
  ignore: !live || !recipient,
  async fn() {
    // This process has seen no inbound message, so its idea of the window is
    // empty. State that says "open" stands in for the inbound message you sent
    // from the handset a moment ago; everything after it is the real send
    // path, markup conversion included.
    const t = trigger({
      state: {
        claim: () => true,
        windowEndsAt: () => Date.now() + 60_000,
        setWindowEndsAt: () => {},
      },
    });
    await t.start(noop as (e: AgentEvent) => Promise<RunResult>);
    try {
      assertEquals(await t.deliver(`whatsapp:${recipient}`, "**Live test** from Looped AF"), true);
    } finally {
      await t.stop();
    }
  },
});
