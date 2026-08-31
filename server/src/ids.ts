import { createHash, randomBytes } from "node:crypto";

let lastMs = 0;
let sequence = 0;

/** UUID v7 with a monotonic 12-bit counter for same-millisecond inserts. */
export function uuidV7(now = Date.now()): string {
  if (now === lastMs) sequence = (sequence + 1) & 0x0fff;
  else {
    lastMs = now;
    sequence = randomBytes(2).readUInt16BE(0) & 0x0fff;
  }
  const bytes = randomBytes(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A UUID that is the same every time for the same name.
 *
 * Captures of one conversation must produce one session, and everything derived
 * from the session id — its turns, its blocks — has to keep its identity as the
 * conversation grows. A random id per capture made the ids of the same turn
 * differ between the file as it was and the file as it is, so anything that
 * pointed at a turn pointed at nothing after the next capture.
 *
 * Version 5 as specified: SHA-1 over the namespace and the name.
 */
export function uuidV5(name: string, namespace = MEMOAR_NAMESPACE): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = 0x50 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Namespace for every name memoar derives an id from. */
const MEMOAR_NAMESPACE = "6ba7b8109dad11d180b400c04fd430c8";
