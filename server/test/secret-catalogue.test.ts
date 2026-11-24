import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretScanner } from "../src/ingest/detection.js";
import { maskLiterals, SECRET_PATTERNS } from "../src/redaction.js";
import { SECRET_CATALOGUE } from "../src/secret-catalogue.js";

/**
 * The archive's half of the scanner parity check.
 *
 * The capture agent runs the same corpus against the same catalogue in
 * `agent/crates/memoar-daemon/src/tests/secret_catalogue.rs`. Both sides must
 * produce the `masked` text and the `count` written in the fixture, so they
 * agree with each other by agreeing with it. Before this, an `AKIA…` key went up
 * unredacted under `--redact-secrets` and the archive did not flag it either.
 */
const FIXTURES = resolve(import.meta.dirname, "fixtures/secret-scanner");

type Part = string | { repeat: string; times: number };
interface CorpusCase {
  name: string;
  parts: Part[];
  masked?: string;
  count: number;
  kinds: string[];
  json?: boolean;
}
interface Corpus {
  budgetMs: number;
  cases: CorpusCase[];
}

const catalogue = JSON.parse(readFileSync(resolve(FIXTURES, "catalogue.json"), "utf8")) as { rules: unknown[] };
const corpus = JSON.parse(readFileSync(resolve(FIXTURES, "corpus.json"), "utf8")) as Corpus;

/** Joined at run time, so no file in the repository spells a credential out. */
const textOf = (parts: Part[]) => parts.map((part) => (typeof part === "string" ? part : part.repeat.repeat(part.times))).join("");
/** Each side writes its own marker. The fixture writes them all as one. */
const normalized = (text: string) => text.replace(/\[REDACTED[^\]]*\]/gu, "[REDACTED]");

describe("the secret catalogue", () => {
  it("is the table the fixture describes, rule for rule and in order", () => {
    expect(SECRET_CATALOGUE).toEqual(catalogue.rules);
  });

  it("keeps to what V8 and Rust's regex crate read the same way", () => {
    for (const { id, pattern } of SECRET_CATALOGUE) {
      expect(pattern, `${id}: lookaround is not in Rust's regex crate`).not.toMatch(/\(\?<?[=!]/u);
      expect(pattern, `${id}: backreferences are not in Rust's regex crate`).not.toMatch(/\\[1-9]|\\k</u);
      // `\s`, `\w` and `\d` differ between the engines outside ASCII. `[\s\S]`
      // means any character in both and is the one exception.
      expect(pattern.replaceAll(String.raw`[\s\S]`, ""), `${id}: use an explicit ASCII class`).not.toMatch(/\\[sSwWdD]/u);
      // The Rust side rewrites `\b` to the ASCII boundary. An escaped backslash
      // followed by `b` would be rewritten too.
      expect(pattern, `${id}: an escaped backslash before b`).not.toMatch(/\\\\b/u);
      expect(pattern, `${id}: a bare dot means different things to the two engines`).not.toMatch(/(^|[^\\[])\.(?![^[]*\])/u);
    }
  });

  it("names each rule once", () => {
    const ids = SECRET_CATALOGUE.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the shared corpus", () => {
  const scanner = new SecretScanner();

  for (const entry of corpus.cases) {
    it(entry.name, () => {
      const text = textOf(entry.parts);
      if (entry.json) JSON.parse(text);

      const started = performance.now();
      const masked = maskLiterals(text, SECRET_PATTERNS);
      const findings = scanner.scan(Buffer.from(text, "utf8"));
      const elapsed = performance.now() - started;

      expect(normalized(masked), "what the archive serves").toBe(entry.masked ?? text);
      expect(findings.length, "what the archive flags for review").toBe(entry.count);
      expect(findings.map((finding) => finding.kind).sort()).toEqual([...entry.kinds].sort());
      expect(elapsed, "a rule that backtracks across the input").toBeLessThan(corpus.budgetMs);
      if (entry.json) JSON.parse(masked);
      for (const finding of findings) {
        expect(text.slice(finding.start, finding.end).length, "a finding addresses the secret").toBeGreaterThan(0);
      }
    });
  }
});
