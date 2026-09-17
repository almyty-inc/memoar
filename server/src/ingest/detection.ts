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

export class FormatDetector {
  detect(sourceHeader: string, bytes: Uint8Array): { source: string; version: string } {
    const [source, statedVersion] = sourceHeader.split("@", 2);
    if (statedVersion) return { source: source!, version: statedVersion };
    if (source && SOURCE_ALIASES[source]) return SOURCE_ALIASES[source];
    if (source && isSqliteBytes(bytes) && SQLITE_SOURCE_VERSIONS[source]) {
      return { source, version: SQLITE_SOURCE_VERSIONS[source] };
    }
    const text = Buffer.from(bytes.subarray(0, 2048)).toString("utf8");
    if (source === "claude-code" && text.includes('"parentUuid"')) return { source, version: "v1" };
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

  private scanText(text: string, patterns: readonly SecretPattern[], previewPrefix = ""): SecretFinding[] {
    return patterns.flatMap(({ kind, expression }) => [...text.matchAll(expression)].map((match) => ({
      kind,
      start: match.index,
      end: match.index + match[0].length,
      preview: `${previewPrefix}${match[0].slice(0, 4)}…${match[0].slice(-4)}`,
    })));
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
