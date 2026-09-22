import { describe, expect, it } from "vitest";
import { SecretScanner } from "../src/ingest/detection.js";

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
