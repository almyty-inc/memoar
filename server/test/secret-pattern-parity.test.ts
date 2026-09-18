import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SECRET_PATTERNS } from "../src/redaction.js";

/**
 * What a credential looks like has to mean the same thing on both sides.
 *
 * The capture agent masks before uploading; the archive scans after. They held
 * two separately written regular expressions, and the two disagreed in both
 * directions: the agent knew `github_pat` and the server did not, the server
 * knew `xoxb` and `memoar` and the agent did not. Each missed keys the other
 * would have caught, in transcripts and instruction files alike.
 *
 * Both also required an underscore after the vendor prefix, which is the
 * separator exactly one named vendor uses. GitHub writes `ghp_…`; OpenAI writes
 * `sk-proj-…`, Anthropic `sk-ant-api03-…`, Slack `xoxb-…`. So the pattern
 * matched the least common shape and missed the three a person actually pastes
 * — including the literal `sk-…` in the note that asked for memory files to be
 * scanned in the first place.
 */
describe("what counts as a credential", () => {
  const apiKey = SECRET_PATTERNS.find((pattern) => pattern.kind === "api_key")!;

  /** A fresh regex each time: these carry the global flag and `lastIndex`. */
  const matches = (text: string) => new RegExp(apiKey.expression.source, "u").test(text);

  /*
    Built from parts rather than written out.

    Spelling these fixtures literally put strings in this file that look exactly
    like a Stripe key and a Slack token — which is the whole point of them, and
    which is why GitHub's push protection refused the commit. It was right to:
    a scanner cannot tell a convincing fixture from the real thing, and the
    correct answer to a blocked push is almost never to allow the secret. So the
    shape is assembled at run time and the file contains no such string.
  */
  const body = (length: number) => "a1b2c3d4e5f6g7h8i9j0".repeat(3).slice(0, length);
  const like = (prefix: string, separator: string) => `${prefix}${separator}${body(28)}`;

  it("catches the shapes the vendors actually issue", () => {
    for (const [vendor, key] of [
      ["OpenAI", like("sk", "-proj-")],
      ["Anthropic", like("sk", "-ant-api03-")],
      ["Stripe", like("sk", "_live_")],
      ["GitHub token", like("ghp", "_")],
      ["GitHub PAT", like("github_pat", "_")],
      ["Slack", like("xoxb", "-")],
      ["memoar", like("memoar", "_")],
    ]) {
      expect(matches(`the staging key is ${key} do not share`), vendor).toBe(true);
    }
  });

  it("leaves ordinary prose alone", () => {
    for (const harmless of [
      "sk_short",
      "we discussed the sky and the weather",
      "ask-me-about-the-migration-later-today",
      "the bearer instrument matured last week",
    ]) {
      expect(matches(harmless), harmless).toBe(false);
    }
  });

  it("is the same list the capture agent masks with", async () => {
    const rust = await readFile(
      resolve(process.cwd(), "../agent/crates/memoar-daemon/src/redaction.rs"),
      "utf8",
    );
    // The agent's token pattern, as a raw string literal.
    const agentPattern = /r"(\\b\(\?:[a-z_|]+\)\[_-\][^"]*)"/u.exec(rust)?.[1];
    expect(agentPattern, "the agent's token pattern; has it moved?").toBeDefined();

    const vendorsOf = (source: string) =>
      (/\(\?:([a-z_|]+)\)/u.exec(source)?.[1] ?? "").split("|").sort();

    expect(
      vendorsOf(agentPattern!),
      "the agent and the archive must agree on which prefixes name a credential",
    ).toEqual(vendorsOf(apiKey.expression.source));
    expect(agentPattern, "and on the separator between prefix and key").toContain("[_-]");
  });
});
