/**
 * Thrown by {@linkcode readCapped} when a body runs past its ceiling. Carries
 * the ceiling so a caller can say what the limit was without repeating it.
 */
export class BodyTooLargeError extends Error {
  /** The ceiling the body exceeded, in bytes. */
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`body exceeded ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/**
 * Read a request or response body into memory, refusing once it passes
 * `maxBytes`.
 *
 * `arrayBuffer()` has no ceiling, so it buffers whatever the far end decides
 * to send. That is fine when the far end is a service we authenticated to and
 * a problem when it is anyone on the internet: a signature can only be checked
 * once the whole body is in hand, which means the bytes arrive before we know
 * whether to trust them. A chunked body declares no length at all, so the
 * content-length header is a hint rather than a control and the count has to
 * happen as the stream arrives.
 *
 * The stream is cancelled as soon as the limit is passed, so a sender that
 * keeps going is disconnected rather than followed.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
