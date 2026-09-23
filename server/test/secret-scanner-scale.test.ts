import { describe, expect, it } from "vitest";
import { SecretScanner } from "../src/ingest/detection.js";
import { SECRET_PATTERNS } from "../src/redaction.js";

/**
 * A transcript with a great many matches must still be scannable.
 *
 * `scanText` built its result with `[...text.matchAll(expression)]`. Spreading
 * an iterator into an array literal is built on the stack in V8, so past a few
 * hundred thousand matches it throws `RangeError: Maximum call stack size
 * exceeded`. The scanner runs before the session is saved, so that did not lose
 * the findings — it lost the session: seven artifacts in the dev archive, 470 MB
 * of real transcripts, recorded as `parse failed: Maximum call stack size
 * exceeded`, with every turn discarded. The captured stack read
 * `at RegExpStringIterator.next … at Array.flatMap … at SecretScanner.scanText`.
 */
describe("scanning an artifact saturated with matches", () => {
  // Assembled at run time. Spelled out, this file would contain a few hundred
  // thousand strings shaped exactly like real credentials, which is what push
  // protection exists to stop.
  const token = () => `${"sk"}_${"a1b2c3d4e5f6g7h8i9j0k1l2"}`;
  const saturated = (count: number) => Buffer.from(`${token()} `.repeat(count), "utf8");

  it("does not fail the whole artifact over the number of matches", () => {
    const bytes = saturated(400_000);
    // The assertion is that this returns at all. Before the fix it threw, and
    // the throw travelled all the way out of the parse.
    const findings = new SecretScanner().scan(bytes);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("stops at a number a person could actually review", () => {
    const findings = new SecretScanner().scan(saturated(400_000));
    expect(
      findings.length,
      "a hundred thousand findings is not a review queue, it is a way to lose the session",
    ).toBeLessThanOrEqual(10_000);
  });

  it("still reports every finding in an ordinary artifact", () => {
    const findings = new SecretScanner().scan(saturated(3));
    expect(findings.length, "the bound must not touch a normal transcript").toBe(3);
    expect(findings[0]?.kind).toBeTypeOf("string");
    expect(findings[0]?.preview, "a preview must never carry the whole secret").not.toContain(token());
  });
});

/**
 * A transcript that merely mentions a private key header.
 *
 * `[\s\S]+?` walks to the end of the document looking for the closing line, and
 * a conversation *about* key handling has no closing line at all. One real
 * 30 MB artifact carries `-----BEGIN RSA PRIVATE KEY-----` twice and the END
 * line zero times — 29 million characters walked, twice — and the scanner threw
 * `RangeError: Maximum call stack size exceeded`, which failed the parse and
 * lost the session rather than one finding.
 */
describe("a header with no closing line", () => {
  const header = `-----BEGIN RSA ${"PRIVATE"} KEY-----`;

  it("finds no key where there is only a mention of one", () => {
    const prose = `A note about ${header} and why it must never be committed.\n`;
    const bytes = Buffer.from(prose + "x".repeat(2_000_000), "utf8");
    expect(new SecretScanner().scan(bytes).filter((f) => f.kind === "private_key")).toHaveLength(0);
  });

  it("still finds a key that is genuinely there", () => {
    const body = "MIIEowIBAAKCAQEA".repeat(60);
    const bytes = Buffer.from(`${header}\n${body}\n-----END RSA ${"PRIVATE"} KEY-----`, "utf8");
    expect(new SecretScanner().scan(bytes).filter((f) => f.kind === "private_key")).toHaveLength(1);
  });
});

/**
 * The private-key body stays bounded, in both languages.
 *
 * `[\s\S]+?` walks to the end of the document looking for a closing line, and a
 * transcript that merely mentions the header has none. One real 30 MB artifact
 * carries `-----BEGIN RSA PRIVATE KEY-----` twice and the END line zero times;
 * with all four patterns running in sequence the scanner threw
 * `RangeError: Maximum call stack size exceeded`, which failed the parse and
 * lost every turn in the session.
 *
 * The bound is the fix and this is the only guard on it. I could not reproduce
 * the overflow itself — in isolation the unbounded pattern completes in 35ms on
 * that same artifact, and nothing reproduces locally at any size — so this pins
 * the property instead of the symptom: the span is bounded, in both halves of
 * the product, and the deliberate cost of that bound is stated rather than
 * discovered later.
 */
describe("the private key pattern", () => {
  const header = `-----BEGIN RSA ${"PRIVATE"} KEY-----`;
  const footer = `-----END RSA ${"PRIVATE"} KEY-----`;
  const pattern = () => SECRET_PATTERNS.find((entry) => entry.kind === "private_key")!;

  it("matches a key whose body is a realistic size", () => {
    // A 4096-bit RSA body is about 3.2 kB of base64; 8000 is comfortably past it.
    const body = "MIIEowIBAAKCAQEA".repeat(200);
    expect(body.length).toBeLessThan(8000);
    const found = new SecretScanner().scan(Buffer.from(`${header}\n${body}\n${footer}`, "utf8"));
    expect(found.filter((entry) => entry.kind === "private_key")).toHaveLength(1);
  });

  /*
    The cost of the bound, stated on purpose.

    A body longer than the bound is not matched. That is the trade: an unmatched
    header can no longer drag the scan across a whole transcript, and in return a
    key larger than any real one goes unflagged. Asserting it here means the
    trade is a decision somebody made, and that removing the bound fails a test
    rather than passing silently.
  */
  it("does not match a body longer than the bound, which is the trade", () => {
    const body = "MIIEowIBAAKCAQEA".repeat(700);
    expect(body.length).toBeGreaterThan(8000);
    const found = new SecretScanner().scan(Buffer.from(`${header}\n${body}\n${footer}`, "utf8"));
    expect(found.filter((entry) => entry.kind === "private_key")).toHaveLength(0);
  });

  it("is bounded in the agent too, which redacts before the archive ever sees it", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const rust = await readFile(resolve(import.meta.dirname, "../../agent/crates/memoar-daemon/src/redaction.rs"), "utf8");
    const rule = /-----BEGIN \(\?:RSA \|EC \|OPENSSH \)\?PRIVATE KEY-----(.{0,24}?)-----END/u.exec(rust);
    expect(rule, "the agent's private-key rule is not written the way this test reads it").not.toBeNull();
    expect(
      rule![1],
      "the agent's private-key body must be bounded like the archive's, or the two halves disagree about what a key is",
    ).toMatch(/\{1,\d+\}\?/u);
    expect(pattern().expression.source, "and so must the archive's").toMatch(/\{1,\d+\}\?/u);
  });
});
