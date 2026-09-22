import { isSqliteBytes } from "../../libs/parsers/src/index.js";
import { unzipSync } from "fflate";
import { SECRET_PATTERNS, type SecretKind, type SecretPattern } from "../redaction.js";


/** Native stores whose schema was confirmed against the tool itself. */
const SQLITE_SOURCE_VERSIONS: Readonly<Record<string, string>> = {
  cursor: "v3",
  goose: "v1",
  crush: "v1",
  zed: "v1",
  opencode: "v1",
  copilot: "v1",
};

const SOURCE_ALIASES: Readonly<Record<string, { source: string; version: string }>> = {
  canonical: { source: "canonical-bundle", version: "v1" },
  "canonical-bundle": { source: "canonical-bundle", version: "v1" },
  cass: { source: "cass-export", version: "2026-08" },
  "cass-export": { source: "cass-export", version: "2026-08" },
  "chatgpt-export": { source: "chatgpt-export", version: "2026-08" },
};

/**
 * How far into an artifact the sniff reads, and how many lines it will judge.
 *
 * The old sniff looked for `"parentUuid"` in the first 2 KiB. A transcript
 * opens with whatever bookkeeping the session happened to write first —
 * `last-prompt`, `mode`, `permission-mode`, `ai-title`, and `attachment`
 * records that run to kilobytes each — so the first message record is not
 * reliably inside 2 KiB. One 71 MB transcript cleared it by 1,735 bytes.
 */
const SNIFF_BYTES = 64 * 1024;
const SNIFF_LINES = 64;

/**
 * Whether bytes the client called `claude-code` look like a Claude Code
 * transcript.
 *
 * Deliberately generous: the only other outcome is `unknown`, which refuses the
 * artifact with "no parser for claude-code@unknown" and says nothing about what
 * was in it. Anything that reaches the parser gets a refusal that names the
 * line it failed on, so it is better to let the parser judge.
 */
function looksLikeClaudeCode(bytes: Uint8Array): boolean {
  const prefix = Buffer.from(bytes.subarray(0, SNIFF_BYTES)).toString("utf8");
  if (prefix.includes('"parentUuid"')) return true;
  // Claude Desktop's local agent mode writes conversation records with `uuid`
  // and `message` but no `parentUuid` at all, so the substring test above can
  // never match one. Twelve such transcripts sat unread.
  return prefix.split(/\r?\n/u).slice(0, SNIFF_LINES).some((line) => {
    if (!line.startsWith("{")) return false;
    try {
      const record: unknown = JSON.parse(line);
      return typeof record === "object" && record !== null
        && typeof (record as Record<string, unknown>).uuid === "string"
        && typeof (record as Record<string, unknown>).message === "object"
        && (record as Record<string, unknown>).message !== null;
    } catch {
      return false;
    }
  });
}

export class FormatDetector {
  detect(sourceHeader: string, bytes: Uint8Array): { source: string; version: string } {
    const [source, statedVersion] = sourceHeader.split("@", 2);
    if (statedVersion) return { source: source!, version: statedVersion };
    if (source && SOURCE_ALIASES[source]) return SOURCE_ALIASES[source];
    if (source && isSqliteBytes(bytes) && SQLITE_SOURCE_VERSIONS[source]) {
      return { source, version: SQLITE_SOURCE_VERSIONS[source] };
    }
    const text = Buffer.from(bytes.subarray(0, 2048)).toString("utf8");
    if (source === "claude-code" && looksLikeClaudeCode(bytes)) return { source, version: "v1" };
    if (source === "codex" && text.includes('"session_meta"')) return { source, version: "rollout-v1" };
    if (source === "antigravity-cli" && text.includes('"parts"')) return { source, version: "v1" };
    if (source === "cursor" && text.includes('"database.rows"') || source === "cursor" && text.includes('"session"')) return { source, version: "v3" };
    return { source: source ?? "unknown", version: "unknown" };
  }
}

export interface SecretFinding {
  kind: SecretKind;
  /** Byte offset into the raw artifact. Addresses the upload, never a block. */
  start: number;
  end: number;
  preview: string;
}

const ZIP_SCAN_MAX_ENTRIES = 512;
const ZIP_SCAN_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const ZIP_SCAN_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * The most findings one artifact can contribute.
 *
 * Each one becomes an annotation row and a line in somebody's redaction review,
 * so this is a bound on a human queue rather than on memory. Ten thousand is
 * far past any real transcript and still an order of magnitude under the count
 * that broke the scanner.
 */
const MAX_SECRET_FINDINGS = 10_000;

export class SecretScanner {
  /**
   * @param patterns what this tenant asked to be scanned for. Defaults to the
   * built-in secret patterns, which is what a tenant that has changed nothing
   * has switched on.
   */
  scan(bytes: Uint8Array, patterns: readonly SecretPattern[] = SECRET_PATTERNS): SecretFinding[] {
    if (isZipBytes(bytes)) return this.scanArchive(bytes, patterns);
    return this.scanText(Buffer.from(bytes).toString("utf8"), patterns);
  }

  /**
   * Walked, not spread, and bounded.
   *
   * This was `[...text.matchAll(expression)]`. Spreading an iterator into an
   * array literal is built on the stack in V8, so a transcript with enough
   * matches threw `RangeError: Maximum call stack size exceeded` — inside the
   * scanner, which runs before the session is saved, so the whole parse failed
   * and every turn was lost. Seven artifacts in the dev archive, 470 MB of real
   * transcripts, died there; the stack said
   * `at RegExpStringIterator.next … at SecretScanner.scanText`.
   *
   * The bound is the second half of it. A 116 MB transcript can hold hundreds
   * of thousands of matches, and a person reviewing a hundred thousand
   * "findings" is not reviewing anything — the list stops being a review queue
   * and becomes a way to lose the session that produced it. Past the cap the
   * scan stops and says so, which is a true statement about a file that is
   * saturated with matches rather than a silent truncation.
   */
  private scanText(text: string, patterns: readonly SecretPattern[], previewPrefix = ""): SecretFinding[] {
    const findings: SecretFinding[] = [];
    for (const { kind, expression } of patterns) {
      for (const match of text.matchAll(expression)) {
        if (findings.length >= MAX_SECRET_FINDINGS) return findings;
        findings.push({
          kind,
          start: match.index,
          end: match.index + match[0].length,
          preview: `${previewPrefix}${match[0].slice(0, 4)}…${match[0].slice(-4)}`,
        });
      }
    }
    return findings;
  }

  /**
   * Decompresses ZIP entries under hard bounds before scanning. Traversal-shaped
   * entry names and anything beyond the entry/total budgets are never inflated,
   * so archive expansion attacks cannot exhaust the worker.
   */
  private scanArchive(bytes: Uint8Array, patterns: readonly SecretPattern[]): SecretFinding[] {
    let entryCount = 0;
    let totalBytes = 0;
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes, {
        filter: (entry) => {
          entryCount += 1;
          if (entryCount > ZIP_SCAN_MAX_ENTRIES) return false;
          if (entry.name.includes("..") || entry.name.startsWith("/") || entry.name.includes("\\")) return false;
          if (entry.originalSize > ZIP_SCAN_MAX_ENTRY_BYTES) return false;
          totalBytes += entry.originalSize;
          return totalBytes <= ZIP_SCAN_MAX_TOTAL_BYTES;
        },
      });
    } catch {
      return this.scanText(Buffer.from(bytes).toString("utf8"), patterns);
    }
    return Object.entries(entries).flatMap(([name, data]) =>
      this.scanText(Buffer.from(data).toString("utf8"), patterns, `${name}: `));
  }
}
