/**
 * Constant-time string comparison, for secrets that arrive over the wire:
 * bearer tokens, webhook signatures, verification handshakes. Every byte of
 * both strings is read whatever happens, so how long the comparison takes
 * says nothing about how much of the value an attacker got right.
 *
 * Lengths are folded into the result rather than short-circuiting on them,
 * which is why the loop indexes modulo each length instead of bailing out.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Two empty strings are equal, and every caller here is comparing a secret,
  // so answering "equal" would turn an unset token into a key that opens the
  // door for anyone. The env-var checks at startup are what normally stops
  // this; a trigger built by hand in code reaches it. Refusing costs nothing:
  // an attacker already knows whether they sent an empty value.
  if (ab.length === 0 || bb.length === 0) return false;
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) {
    diff |= (ab[i % ab.length] ?? 0) ^ (bb[i % bb.length] ?? 0);
  }
  return diff === 0;
}
