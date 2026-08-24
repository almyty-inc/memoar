import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { SecretScanner } from "../src/ingest.js";

/** Built at runtime so the repo's own secret scan does not flag this fixture. */
const LIVE_KEY_FIXTURE = ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_");

const scanner = new SecretScanner();
const apiKey = LIVE_KEY_FIXTURE;

describe("secret scanning", () => {
  it("finds secrets in plain bytes", () => {
    const findings = scanner.scan(strToU8(`config token ${apiKey} end`));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("api_key");
  });

  it("inspects decompressed ZIP entries and names the entry in the preview", () => {
    const archive = zipSync({
      "conversations.json": strToU8(JSON.stringify({ note: "clean" })),
      "nested/.env": strToU8(`API_TOKEN=${apiKey}\n`),
    });
    const findings = scanner.scan(archive);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((finding) => finding.preview.startsWith("nested/.env: "))).toBe(true);
  });

  it("never inflates traversal-shaped entry names", () => {
    const archive = zipSync({
      "../escape.txt": strToU8(`leak ${apiKey}`),
      "/absolute.txt": strToU8(`leak ${apiKey}`),
      "safe.txt": strToU8("nothing to see"),
    });
    const findings = scanner.scan(archive);
    expect(findings).toHaveLength(0);
  });

  it("skips entries beyond the expansion budget instead of inflating them", () => {
    const huge = new Uint8Array(17 * 1024 * 1024).fill(0x61);
    const archive = zipSync({ "huge.txt": huge, "small.txt": strToU8(`k ${apiKey}`) });
    const findings = scanner.scan(archive);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.preview.startsWith("small.txt: ")).toBe(true);
  });

  it("falls back to a byte scan for corrupt archives", () => {
    const corrupt = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...strToU8(` broken ${apiKey}`)]);
    const findings = scanner.scan(corrupt);
    expect(findings).toHaveLength(1);
  });
});
