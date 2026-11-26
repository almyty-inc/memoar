import { createHash } from "node:crypto";
import type { TokenTotals, Turn } from "../../canonical/src/generated.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a JSONL read actually saw, so a refusal can say more than "not JSONL". */
export interface JsonLinesReport {
  /** The lines that were a JSON object, in file order. */
  records: Record<string, unknown>[];
  /** Non-blank lines the artifact held. */
  total: number;
  /** Non-blank lines that were not JSON, or were JSON but not an object. */
  invalid: number;
  /** Where the reading first went wrong, and what the line looked like. */
  firstInvalid: { line: number; reason: string; sample: string } | null;
  /** NUL bytes: something binary was offered as a transcript. */
  binary: boolean;
}

const SAMPLE_LIMIT = 96;

/**
 * A short, printable stand-in for a line, safe to put in a diagnostic.
 *
 * Diagnostics are read by people and stored next to the artifact, so a sample
 * must not carry control characters, a decoder's replacement characters, or
 * enough of the line to amount to a copy of its content.
 */
export function sampleOf(line: string): string {
  const clipped = line.length > SAMPLE_LIMIT ? `${line.slice(0, SAMPLE_LIMIT)}…` : line;
  return clipped.replace(/[\p{Cc}\p{Cf}�]/gu, (char) => `\\x${char.codePointAt(0)!.toString(16).padStart(2, "0")}`);
}

/**
 * Every JSON object the artifact holds, plus an account of what it could not
 * read.
 *
 * The `parseJsonLines` this replaced gave up on the whole artifact at the first
 * line that was not JSON. A 26,462-line transcript with 16 corrupt lines parsed as zero
 * turns — 71 MB of session lost over 0.06% of its lines. Reading line by line
 * keeps the 26,445 that were fine and lets the caller judge the remainder.
 */
export function readJsonLines(raw: Uint8Array): JsonLinesReport {
  const buffer = Buffer.from(raw);
  const records: Record<string, unknown>[] = [];
  let total = 0;
  let invalid = 0;
  let firstInvalid: JsonLinesReport["firstInvalid"] = null;
  // The reason is sanitised too: V8 quotes the offending line back inside its
  // own message, so an unescaped byte would reach the diagnostic through it.
  const note = (line: number, reason: string, text: string): void => {
    invalid += 1;
    firstInvalid ??= { line, reason: sampleOf(reason), sample: sampleOf(text) };
  };
  for (const [index, line] of buffer.toString("utf8").split(/\r?\n/u).entries()) {
    if (!line) continue;
    total += 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      note(index + 1, error instanceof Error ? error.message : "not JSON", line);
      continue;
    }
    if (!isRecord(value)) {
      note(index + 1, `a JSON ${Array.isArray(value) ? "array" : typeof value}, not an object`, line);
      continue;
    }
    records.push(value);
  }
  return { records, total, invalid, firstInvalid, binary: buffer.includes(0) };
}

/**
 * How much of an artifact has to be JSON before it counts as JSON lines.
 *
 * A transcript is a file of JSON lines, not a file that happens to contain one.
 * Real transcripts miss by a hair: the worst Claude Code transcript seen had 16
 * bad lines in 26,462, and the worst Codex rollout on the dev archive 22 in
 * 2,444. A tool-result dump that quotes a transcript read 0 of 216. Nothing
 * observed sits near a half, so the threshold does not need placing delicately.
 */
export const MIN_JSON_SHARE = 0.5;

/**
 * The records of an artifact that is mostly JSON lines, or null when it is not.
 *
 * For parsers that used the all-or-nothing `parseJsonLines` and so lost a
 * whole session to one line. Eight Codex rollouts on the dev archive, up to 48 MB each, were refused
 * as "requires session_meta followed by response_item events" while holding
 * both: a redaction pass in the capture agent before 2026-09-19 had eaten the
 * backslash off an escaped quote on 1 to 22 of their lines.
 */
export function mostlyJsonLines(raw: Uint8Array): Record<string, unknown>[] | null {
  const read = readJsonLines(raw);
  if (read.records.length === 0 || read.total - read.invalid < read.total * MIN_JSON_SHARE) return null;
  return read.records;
}

export function stringValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Whether a value can be stored in a uuid column at all. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** The namespace every derived id in memoar shares. Mirrors `uuidV5` in the server. */
const MEMOAR_NAMESPACE = "6ba7b8109dad11d180b400c04fd430c8";

/**
 * A uuid derived from a name, the same every time.
 *
 * The server has this too, as `uuidV5`. It is repeated here because the parsers
 * are a library the server depends on and not the other way round, and a test
 * asserts the two produce identical output so they cannot drift apart.
 */
export function derivedUuid(name: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(MEMOAR_NAMESPACE, "hex"))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = 0x50 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The id a turn is stored under, given whatever the source called it.
 *
 * Turn ids are a uuid column. A source id handed straight to it works only for
 * as long as every tool numbers its messages with uuids; the moment one does
 * not, the *whole session* is refused with `invalid input syntax for type uuid`
 * — parsed correctly, never archived.
 *
 * A native uuid is kept as it is, so nothing already archived moves. Anything
 * else is derived from the session and the native id together: deterministic,
 * so re-capturing the same conversation lands on the same turn again, and
 * scoped to the session, so two sessions that both call a message "1" do not
 * collide.
 */
export function turnId(nativeId: string, sessionId: string): string {
  return isUuid(nativeId) ? nativeId : derivedUuid(`${sessionId}:turn:${nativeId}`);
}

/**
 * The same for a block, kept in its own name space.
 *
 * Separate from `turnId` so that a store whose message and part tables share an
 * id does not derive the same uuid for both.
 */
export function blockId(nativeId: string, sessionId: string): string {
  return isUuid(nativeId) ? nativeId : derivedUuid(`${sessionId}:block:${nativeId}`);
}

/** The same mapping for a parent link, which may legitimately be absent. */
export function mapParent(nativeParentId: string | null, sessionId: string): string | null {
  return nativeParentId === null ? null : turnId(nativeParentId, sessionId);
}

export function incrementUuid(uuid: string, amount: number): string {
  const compact = uuid.replaceAll("-", "");
  const incremented = (BigInt(`0x${compact}`) + BigInt(amount)).toString(16).padStart(32, "0");
  return `${incremented.slice(0, 8)}-${incremented.slice(8, 12)}-${incremented.slice(12, 16)}-${incremented.slice(16, 20)}-${incremented.slice(20)}`;
}

/**
 * Converts an epoch stamp to ISO 8601, accepting both seconds and milliseconds.
 *
 * Several stores keep an integer here and differ on the unit, and a value read
 * in the wrong one lands in 1970 or in the far future rather than failing
 * visibly. Anything past this threshold cannot be seconds within any plausible
 * lifetime of a transcript.
 */
export function epochToIso(value: unknown, fallback: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  const milliseconds = value > 100_000_000_000 ? value : value * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? fallback : date.toISOString();
}

/** Blocks per turn that a fallback id scheme can hold without colliding. */
const FALLBACK_STRIDE = 4096;

/** Distance block ids sit from the session id, clear of any turn id. */
const FALLBACK_BASE = 0x1000000;

/**
 * Id for a block that carries none of its own.
 *
 * Always derived from the session id, never from the turn id. Native stores
 * allocate message ids sequentially, so `turnId + 1` frequently *is* the next
 * turn's id — a session whose turns were …144 and …145 minted a block …145.
 * Blocks live in their own range, spaced by ordinal so two turns cannot mint
 * the same id.
 */
export function derivedBlockId(_turnId: string, index: number, seedId: string, ordinal: number): string {
  return incrementUuid(seedId, FALLBACK_BASE + ordinal * FALLBACK_STRIDE + index);
}

/**
 * The models a session ran, read off its turns and anything else the store
 * says, where the seed does not already name them. The ingest pipeline seeds
 * `models: []`, so without this every captured session said it used none.
 */
export function sessionModels(seeded: readonly string[], turns: readonly Turn[], ...more: (string | null | undefined)[]): string[] {
  if (seeded.length > 0) return [...seeded];
  const named = [...turns.map((turn) => turn.model), ...more]
    .filter((model): model is string => typeof model === "string" && model.length > 0);
  return [...new Set(named)];
}

/**
 * An assistant turn with its model and the tokens its request used.
 *
 * Every caller used to pass the seed's `tokenTotals`, which the pipeline seeds
 * with zeros, so every turn in the archive said it had used none. A source that
 * records usage passes it here. One that records none leaves the default, and
 * zero is then the honest answer.
 */
export function withModelAndTokens(turn: Turn, model: string | undefined, tokens: TokenTotals = { input: 0, output: 0 }): Turn {
  if (turn.role !== "assistant") return turn;
  return {
    ...turn,
    ...(model ? { model } : {}),
    tokens: { ...tokens },
  };
}

/**
 * Reads a value as an array of unknowns.
 *
 * `Array.isArray` narrows an unknown to `any[]`, and every element taken from
 * it is then an `any` that no later check can catch.
 */
export function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? (value as unknown[]) : null;
}
