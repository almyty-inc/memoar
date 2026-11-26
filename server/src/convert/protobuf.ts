/**
 * The few protobuf wire encodings the Antigravity database needs.
 *
 * Antigravity stores each step as a protobuf message without publishing the
 * schema. Only varints and length-delimited fields are written, which is all
 * the observed user-input and planner-response steps use.
 */
function varint(value: number | bigint): Buffer {
  let remaining = BigInt(value);
  const out: number[] = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    out.push(byte);
  } while (remaining > 0n);
  return Buffer.from(out);
}

function key(field: number, wire: 0 | 2): Buffer {
  return varint((field << 3) | wire);
}

export function intField(field: number, value: number): Buffer {
  return Buffer.concat([key(field, 0), varint(value)]);
}

export function bytesField(field: number, value: string | Buffer): Buffer {
  const data = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([key(field, 2), varint(data.length), data]);
}

export function messageField(field: number, ...parts: Buffer[]): Buffer {
  return bytesField(field, Buffer.concat(parts));
}

/** A `google.protobuf.Timestamp`: seconds and nanoseconds. */
export function timestampField(field: number, iso: string): Buffer {
  const parsed = Date.parse(iso);
  const milliseconds = Number.isNaN(parsed) ? 0 : parsed;
  return messageField(field, intField(1, Math.floor(milliseconds / 1000)), intField(2, (milliseconds % 1000) * 1_000_000));
}
