import { assertEquals } from "@std/assert";
import {
  importVoiceKey,
  ipDiscoveryRequest,
  openRtp,
  parseIpDiscovery,
  parseRtp,
  rtpHeader,
  sealRtp,
} from "./rtp.ts";

function testKey(): Promise<CryptoKey> {
  return importVoiceKey(Array.from({ length: 32 }, (_, i) => i));
}

Deno.test("rtpHeader: version 2, opus payload type, big-endian fields", () => {
  const header = rtpHeader(0xabcd, 0x01020304, 0x0a0b0c0d);
  assertEquals(header[0], 0x80);
  assertEquals(header[1], 0x78);
  const info = parseRtp(new Uint8Array([...header, 0, 0, 0, 0]))!;
  assertEquals(info.seq, 0xabcd);
  assertEquals(info.timestamp, 0x01020304);
  assertEquals(info.ssrc, 0x0a0b0c0d);
  assertEquals(info.unencryptedBytes, 12);
  assertEquals(info.extensionWords, 0);
});

Deno.test("parseRtp: refuses RTCP and non-RTP noise", () => {
  // RTCP sender report: PT 200 → payload type field 72 after the marker bit.
  const rtcp = new Uint8Array(16);
  rtcp[0] = 0x80;
  rtcp[1] = 200;
  assertEquals(parseRtp(rtcp), undefined);
  assertEquals(parseRtp(new Uint8Array([1, 2, 3])), undefined); // too short
  const wrongVersion = new Uint8Array(16);
  wrongVersion[0] = 0x40;
  assertEquals(parseRtp(wrongVersion), undefined);
});

Deno.test("seal and open round-trip an opus payload", async () => {
  const key = await testKey();
  const opus = new Uint8Array([0xf8, 0xff, 0xfe, 1, 2, 3, 4, 5]);
  const header = rtpHeader(1, 960, 42);
  const packet = await sealRtp(key, header, opus, 7);
  const info = parseRtp(packet)!;
  assertEquals(info.ssrc, 42);
  assertEquals(Array.from((await openRtp(key, packet, info))!), Array.from(opus));
});

Deno.test("open: a tampered header fails the seal and returns undefined", async () => {
  const key = await testKey();
  const packet = await sealRtp(key, rtpHeader(1, 960, 42), new Uint8Array([9, 9, 9]), 0);
  const info = parseRtp(packet)!;
  packet[2] ^= 0xff; // flip a header bit — the header is authenticated data
  assertEquals(await openRtp(key, packet, info), undefined);
});

Deno.test("open: extension data is stripped from the plaintext", async () => {
  const key = await testKey();
  // Build a packet the way Discord sends one: header with the extension bit,
  // a 4-byte extension preamble in the clear, and one word of extension data
  // sitting at the start of the ciphertext.
  const header = new Uint8Array(16);
  header.set(rtpHeader(5, 4800, 99));
  header[0] |= 0x10; // extension bit
  const preamble = new DataView(header.buffer, 12);
  preamble.setUint16(0, 0xbede);
  preamble.setUint16(2, 1); // one 32-bit word of extension data
  const opus = new Uint8Array([10, 20, 30]);
  const plain = new Uint8Array([0xde, 0xad, 0xbe, 0xef, ...opus]);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: new Uint8Array(12), additionalData: header },
      key,
      plain,
    ),
  );
  const packet = new Uint8Array([...header, ...sealed, 0, 0, 0, 0]);
  const info = parseRtp(packet)!;
  assertEquals(info.unencryptedBytes, 16);
  assertEquals(info.extensionWords, 1);
  assertEquals(Array.from((await openRtp(key, packet, info))!), Array.from(opus));
});

Deno.test("ip discovery: request shape and response parsing", () => {
  const request = ipDiscoveryRequest(0x11223344);
  assertEquals(request.length, 74);
  assertEquals(Array.from(request.subarray(0, 4)), [0, 1, 0, 70]);

  const response = new Uint8Array(74);
  const view = new DataView(response.buffer);
  view.setUint16(0, 2);
  new TextEncoder().encodeInto("203.0.113.7", response.subarray(8));
  view.setUint16(72, 50_004);
  assertEquals(parseIpDiscovery(response), { address: "203.0.113.7", port: 50_004 });
  // A request echoing back is not a response.
  assertEquals(parseIpDiscovery(request), undefined);
});
