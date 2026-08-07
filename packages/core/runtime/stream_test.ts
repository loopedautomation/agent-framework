import { assert, assertEquals, assertRejects } from "@std/assert";
import { BodyTooLargeError, readCapped } from "./stream.ts";
import { timingSafeEqual } from "./timing.ts";

/** A body that streams `chunks` chunks of `size` bytes, counting what it emitted. */
function stream(chunks: number, size: number) {
  let emitted = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= chunks) return controller.close();
      emitted++;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, emitted: () => emitted, cancelled: () => cancelled };
}

Deno.test("readCapped: a body under the ceiling comes back whole", async () => {
  const s = stream(4, 100);
  assertEquals((await readCapped(s.body, 1_000)).length, 400);
  assertEquals(await readCapped(null, 1_000), new Uint8Array(0));
});

Deno.test("readCapped: an oversized body is refused and the sender disconnected", async () => {
  // A chunked body declares no length, so the count has to happen as it
  // arrives — and the stream is cancelled rather than followed to the end.
  const s = stream(1_000, 100);
  await assertRejects(() => readCapped(s.body, 250), BodyTooLargeError, "250");
  assert(s.cancelled(), "the stream should have been cancelled");
  assert(s.emitted() < 10, `read ${s.emitted()} chunks past the limit`);
});

Deno.test("readCapped: the ceiling is exact", async () => {
  assertEquals((await readCapped(stream(1, 100).body, 100)).length, 100);
  await assertRejects(() => readCapped(stream(1, 101).body, 100), BodyTooLargeError);
});

Deno.test("timingSafeEqual: equal strings match, everything else does not", () => {
  assert(timingSafeEqual("sha256=abc", "sha256=abc"));
  assert(!timingSafeEqual("sha256=abc", "sha256=abd"));
  assert(!timingSafeEqual("ab", "abab")); // length is folded in, not short-circuited
  assert(!timingSafeEqual("", "secret"));
  assert(!timingSafeEqual("secret", ""));
});

Deno.test("timingSafeEqual: two empty strings are not a match", () => {
  // Every caller is comparing a secret, so answering "equal" would turn an
  // unset token into a key that opens the door for anyone.
  assert(!timingSafeEqual("", ""));
});
