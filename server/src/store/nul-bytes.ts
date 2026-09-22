/**
 * Postgres cannot store a NUL. Neither a text column nor jsonb will take the
 * character U+0000, and the refusal — `unsupported Unicode escape sequence` —
 * fails the whole statement, which failed the whole save.
 *
 * Three real transcripts in the archive, 253 MB between them, died exactly
 * there, having got past every other fix on the branch that introduced this. A
 * tool that prints a binary file puts a NUL into its output, and the transcript
 * records the output faithfully. One stray byte in one tool result lost every
 * turn in the session.
 *
 * The replacement is U+FFFD rather than nothing, so the text still shows that
 * something was there. It walks the whole session instead of a list of columns,
 * because NULs arrive in block text, tool data, ext payloads and titles alike,
 * and a list of columns is exactly what a new field would be missing from.
 *
 * Shared by both stores. Only Postgres needs it to avoid an error, but the
 * in-memory store is what the contract suite holds it to, and a store that kept
 * the NUL would hand tests a byte production never returns.
 */

// Built from character codes, not written as escapes: a literal NUL in a
// source file is invisible, makes grep call the file binary, and is exactly the
// kind of byte this function exists to keep out of storage. Writing it as an
// escape put a literal one into the file the first time.
const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

export function withoutNulBytes<T>(value: T): T {
  if (typeof value === "string") return (value.includes(NUL) ? value.replaceAll(NUL, REPLACEMENT) : value) as T;
  if (Array.isArray(value)) return (value as unknown[]).map((item) => withoutNulBytes(item)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[withoutNulBytes(key)] = withoutNulBytes(item);
    return out as T;
  }
  return value;
}
