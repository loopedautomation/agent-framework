import { assert, assertEquals } from "@std/assert";
import { egressAllowed, type EgressEvent, refusalBody, startEgressProxy } from "./egress_proxy.ts";

/** Speak HTTP to the proxy and return whatever it says back. */
async function ask(port: number, requestLine: string): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  await conn.write(new TextEncoder().encode(`${requestLine}\r\n\r\n`));
  const buf = new Uint8Array(4096);
  const n = await conn.read(buf);
  const text = new TextDecoder().decode(buf.subarray(0, n ?? 0));
  try {
    conn.close();
  } catch { /* the proxy may have closed first */ }
  return text;
}

Deno.test("egressAllowed follows the permissions.net rules exactly", () => {
  assert(egressAllowed(["api.github.com"], "api.github.com"));
  assert(!egressAllowed(["api.github.com"], "evil.com"));
  assert(egressAllowed(["*.example.com"], "a.example.com"));
  assert(egressAllowed(["*.example.com"], "deep.a.example.com"));
  // The apex is not a subdomain, here as in the engine.
  assert(!egressAllowed(["*.example.com"], "example.com"));
  assert(egressAllowed(["*"], "anything.at.all"));
  assert(!egressAllowed([], "api.github.com"));
});

Deno.test("CONNECT to a denied host is refused, and the refusal names the fix", async () => {
  const events: EgressEvent[] = [];
  const proxy = startEgressProxy({
    hosts: ["api.github.com"],
    hostname: "127.0.0.1",
    onEvent: (e) => events.push(e),
  });
  try {
    const reply = await ask(proxy.port, "CONNECT evil.example.com:443 HTTP/1.1");
    assert(reply.startsWith("HTTP/1.1 403"), reply.split("\r\n")[0]);
    assert(reply.includes("evil.example.com"));
    // An operator reading this should not have to guess what to change.
    assert(reply.includes("permissions:"));
    assert(reply.includes('net: ["evil.example.com"]'));

    assertEquals(events, [{ host: "evil.example.com", port: 443, decision: "denied" }]);
  } finally {
    proxy.close();
  }
});

Deno.test("an allowed host is tunnelled end to end", async () => {
  // A stand-in for the upstream the agent is allowed to reach.
  const upstream = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
    handler: () => new Response("upstream says hello"),
  });
  const upstreamPort = upstream.addr.port;

  const events: EgressEvent[] = [];
  const proxy = startEgressProxy({
    hosts: ["127.0.0.1"],
    hostname: "127.0.0.1",
    onEvent: (e) => events.push(e),
  });
  try {
    // Plain HTTP through the proxy uses an absolute URI rather than CONNECT.
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: proxy.port });
    await conn.write(
      new TextEncoder().encode(
        `GET http://127.0.0.1:${upstreamPort}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
          `Connection: close\r\n\r\n`,
      ),
    );
    const buf = new Uint8Array(4096);
    const n = await conn.read(buf);
    const reply = new TextDecoder().decode(buf.subarray(0, n ?? 0));
    try {
      conn.close();
    } catch { /* upstream may have closed */ }

    assert(reply.includes("upstream says hello"), reply.slice(0, 120));
    assertEquals(events[0].decision, "allowed");
    assertEquals(events[0].host, "127.0.0.1");
  } finally {
    proxy.close();
    await upstream.shutdown();
  }
});

Deno.test("a plain HTTP request to a denied host is refused too", async () => {
  const proxy = startEgressProxy({ hosts: ["api.github.com"], hostname: "127.0.0.1" });
  try {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: proxy.port });
    await conn.write(
      new TextEncoder().encode("GET http://evil.example.com/x HTTP/1.1\r\n\r\n"),
    );
    const buf = new Uint8Array(2048);
    const n = await conn.read(buf);
    const reply = new TextDecoder().decode(buf.subarray(0, n ?? 0));
    try {
      conn.close();
    } catch { /* ignore */ }
    // CONNECT is not the only way out, so the absolute-URI form is checked too.
    assert(reply.startsWith("HTTP/1.1 403"), reply.split("\r\n")[0]);
    assert(reply.includes("evil.example.com"));
  } finally {
    proxy.close();
  }
});

Deno.test("a request that is neither CONNECT nor absolute-URI is rejected", async () => {
  const proxy = startEgressProxy({ hosts: ["*"], hostname: "127.0.0.1" });
  try {
    const reply = await ask(proxy.port, "GET /healthz HTTP/1.1");
    assert(reply.startsWith("HTTP/1.1 400"), reply.split("\r\n")[0]);
    assert(reply.includes("forward proxy"));
  } finally {
    proxy.close();
  }
});

Deno.test("a malformed CONNECT authority does not reach the allowlist", async () => {
  const events: EgressEvent[] = [];
  const proxy = startEgressProxy({
    hosts: ["*"],
    hostname: "127.0.0.1",
    onEvent: (e) => events.push(e),
  });
  try {
    // No port, so it is not a CONNECT target at all.
    assert((await ask(proxy.port, "CONNECT example.com HTTP/1.1")).startsWith("HTTP/1.1 400"));
    // A port that is not a number, and one out of range.
    assert(
      (await ask(proxy.port, "CONNECT example.com:https HTTP/1.1")).startsWith("HTTP/1.1 400"),
    );
    assert(
      (await ask(proxy.port, "CONNECT example.com:99999 HTTP/1.1")).startsWith("HTTP/1.1 400"),
    );
    // None of them counted as a decision: nothing was allowed or denied.
    assertEquals(events, []);
  } finally {
    proxy.close();
  }
});

Deno.test("Deno's own fetch is routed and refused like any other client", async () => {
  const proxy = startEgressProxy({ hosts: ["api.github.com"], hostname: "127.0.0.1" });
  try {
    const client = Deno.createHttpClient({ proxy: { url: `http://127.0.0.1:${proxy.port}` } });
    // This is the case that matters: the agent's own outbound HTTP goes
    // through the same allowlist as a subprocess, with no separate code path.
    let failed = false;
    try {
      await fetch("https://evil.example.com", {
        client,
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      failed = true;
    }
    assert(failed, "a denied host must not connect");
    client.close();
  } finally {
    proxy.close();
  }
});

Deno.test("refusalBody names the host once in prose and once as config", () => {
  const body = refusalBody("api.stripe.com");
  assert(body.includes('"api.stripe.com" is not in this agent\'s permissions.net allowlist'));
  assert(body.includes('net: ["api.stripe.com"]'));
});
