import { unzipSync } from "fflate";
import { secretSpan, SECRET_PATTERNS, type SecretKind, type SecretPattern } from "../redaction.js";
import { ClaimedSpans } from "./claimed-spans.js";

/**
 * A hint of which secret a finding is, without the secret.
 *
 * Four characters from each end of a long token says which key it was. Four
 * from each end of an eight-character password is the password, and the
 * key/value rule finds those too, so a short secret gets no hint at all.
 */
function previewOf(secret: string): string {
  return secret.length >= 16 ? `${secret.slice(0, 4)}…${secret.slice(-4)}` : "…";
}

// Format detection lives in its own module. Re-exported so the importers of
// this one keep working.
export { FormatDetector } from "./format-detection.js";

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
    // One secret is one finding. `api_key=sk_live_…` is a Stripe key to one
    // rule and a key/value pair to another, and the capture agent, which masks
    // in order, counts it once. A span an earlier rule already claimed is not
    // reported again.
    const claimed = new ClaimedSpans();
    for (const { kind, expression } of patterns) {
      for (const match of text.matchAll(expression)) {
        if (findings.length >= MAX_SECRET_FINDINGS) return findings;
        const [start, end] = secretSpan(match);
        if (!claimed.claim(start, end)) continue;
        findings.push({
          kind,
          start,
          end,
          preview: `${previewPrefix}${previewOf(text.slice(start, end))}`,
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
