import { assert, assertEquals } from "@std/assert";
import { type Attachment, isImageType, resolveAttachments, withNotes } from "./media.ts";

const LIMITS = { maxImageBytes: 1000, maxImagesPerMessage: 2 };

/** An attachment whose bytes are `size` long and whose fetch records that it ran. */
function fake(overlay: Partial<Attachment> & { bytes?: number } = {}): Attachment & {
  fetched: () => boolean;
} {
  let fetched = false;
  const bytes = overlay.bytes ?? 10;
  return {
    filename: "shot.png",
    mediaType: "image/png",
    size: bytes,
    ...overlay,
    fetch: () => {
      fetched = true;
      return Promise.resolve(new Uint8Array(bytes).fill(65));
    },
    fetched: () => fetched,
  };
}

Deno.test("media/an image within the limits reaches the model", async () => {
  const { images, notes } = await resolveAttachments([fake()], LIMITS);
  assertEquals(images.length, 1);
  assertEquals(images[0].mediaType, "image/png");
  assertEquals(atob(images[0].data).length, 10); // round-trips the bytes, not a description of them
  assertEquals(notes, []);
});

Deno.test("media/a file the agent cannot read is named, never dropped", async () => {
  const pdf = fake({ filename: "quarterly.pdf", mediaType: "application/pdf", bytes: 2048 });
  const { images, notes } = await resolveAttachments([pdf], LIMITS);
  assertEquals(images, []);
  assertEquals(notes.length, 1);
  // The agent has to be able to say what arrived and why it didn't look at it.
  assert(notes[0].includes("quarterly.pdf"));
  assert(notes[0].includes("application/pdf"));
  assert(notes[0].includes("not an image"));
  assert(!pdf.fetched(), "a file the agent can't read should not be downloaded");
});

Deno.test("media/an oversized image is named and never downloaded", async () => {
  const big = fake({ filename: "huge.png", bytes: 5000 });
  const { images, notes } = await resolveAttachments([big], LIMITS);
  assertEquals(images, []);
  assert(notes[0].includes("huge.png"));
  assert(notes[0].includes("limit"));
  assert(!big.fetched(), "the size the channel reported is enough to refuse it");
});

Deno.test("media/a channel that lied about the size is caught after the fetch", async () => {
  // Discord reports size; a proxy or a redirect can hand back something else.
  const liar: Attachment = {
    filename: "liar.png",
    mediaType: "image/png",
    size: 10,
    fetch: () => Promise.resolve(new Uint8Array(5000)),
  };
  const { images, notes } = await resolveAttachments([liar], LIMITS);
  assertEquals(images, []);
  assert(notes[0].includes("limit"));
});

Deno.test("media/images past the per-message cap are named, not silently lost", async () => {
  const shots = [fake(), fake(), fake({ filename: "third.png" })];
  const { images, notes } = await resolveAttachments(shots, LIMITS);
  assertEquals(images.length, 2);
  assertEquals(notes.length, 1);
  assert(notes[0].includes("third.png"));
  assert(!shots[2].fetched());
});

Deno.test("media/a failed fetch explains itself to the agent", async () => {
  const gone: Attachment = {
    filename: "expired.png",
    mediaType: "image/png",
    fetch: () => Promise.reject(new Error("404 Not Found")),
  };
  const { images, notes } = await resolveAttachments([gone], LIMITS);
  assertEquals(images, []);
  // Otherwise the agent ignores the thing the user was asking about and says nothing.
  assert(notes[0].includes("expired.png"));
  assert(notes[0].includes("404 Not Found"));
});

Deno.test("media/notes join the prompt so the text always mentions what arrived", () => {
  assertEquals(withNotes("look at this", []), "look at this");
  assertEquals(
    withNotes("look at this", ["[attachment: a.pdf — nope]"]),
    "look at this\n[attachment: a.pdf — nope]",
  );
  // A caption-less upload still needs the note to carry the message.
  assertEquals(withNotes("", ["[attachment: a.pdf — nope]"]), "[attachment: a.pdf — nope]");
});

Deno.test("media/only the formats every provider accepts count as images", () => {
  assert(isImageType("image/png"));
  assert(isImageType("image/jpeg"));
  assert(!isImageType("image/svg+xml")); // a vector no provider will take
  assert(!isImageType("application/pdf"));
  assert(!isImageType(undefined));
});
