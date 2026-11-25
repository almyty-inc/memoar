import { describe, expect, it } from "vitest";
import { decodeSourcePathHeader, repairLatin1Utf8 } from "../src/ingest/source-path.js";

/** What Node hands over for a header whose bytes are this string's UTF-8. */
function asNodeReadsIt(value: string): string {
  return Buffer.from(value, "utf8").toString("latin1");
}

describe("decodeSourcePathHeader", () => {
  it("decodes a percent-encoded UTF-8 path", () => {
    expect(decodeSourcePathHeader("%2FUsers%2F%C3%BCn%C3%AF%20%E6%97%A5%E6%9C%AC%2Fx.jsonl")).toBe("/Users/ünï 日本/x.jsonl");
    expect(decodeSourcePathHeader("C%3A%5Cwork%5Ca.jsonl")).toBe("C:\\work\\a.jsonl");
  });

  it("takes an ASCII path from an older agent exactly as it came", () => {
    for (const raw of ["/tmp/session.jsonl", "/tmp/100%41.jsonl", "/tmp/a%20b", "C:\\work\\%E6.jsonl", "session.jsonl", ""]) {
      expect(decodeSourcePathHeader(raw), raw).toBe(raw);
    }
  });

  it("repairs the raw UTF-8 an older agent sent", () => {
    expect(decodeSourcePathHeader(asNodeReadsIt("/Users/ünï 日本/x"))).toBe("/Users/ünï 日本/x");
  });

  it("keeps escapes that are not UTF-8 rather than guessing", () => {
    expect(decodeSourcePathHeader("%2Ftmp%2F%FF")).toBe("%2Ftmp%2F%FF");
  });
});

describe("repairLatin1Utf8", () => {
  it("undoes a latin1 reading of UTF-8 bytes", () => {
    expect(repairLatin1Utf8("/Users/Ã¼nÃ¯")).toBe("/Users/ünï");
    expect(repairLatin1Utf8(asNodeReadsIt("/Users/日本/🙂"))).toBe("/Users/日本/🙂");
  });

  it("leaves text that is not such a reading alone", () => {
    // ASCII, a lone latin1 letter that is not UTF-8, and text already decoded.
    for (const value of ["/tmp/a", "/Users/é", "/Users/ünï 日本", "/Users/ü"]) {
      expect(repairLatin1Utf8(value), value).toBe(value);
    }
  });

  it("changes nothing when run on its own output", () => {
    const once = repairLatin1Utf8(asNodeReadsIt("/Users/ünï 日本/x"));
    expect(repairLatin1Utf8(once)).toBe(once);
  });
});
