import { ConflictException } from "@nestjs/common";
import type { MemoryDocument, RedactionStatus } from "../../libs/canonical/src/generated.js";
import { SecretScanner } from "../ingest/detection.js";
import { redactionPatterns } from "../redaction.js";
import type { RedactionSettingsRecord } from "../store/records.js";

/** One scanner, shared: it holds no state and compiling patterns per call is waste. */
const scanner = new SecretScanner();

/**
 * What the scanner found in one reading of one memory file.
 *
 * The kinds are kept, one entry per match, and the matched text is not. A
 * count and a list of kinds is all the reviewer needs from the archive — they
 * are about to read the file itself, which is right there — and storing a
 * preview of a credential beside the document would put a fragment of the
 * secret into every listing that mentions it.
 */
export interface MemoryScanResult {
  redactionStatus: Exclude<RedactionStatus, "reviewed">;
  redactionFindings: string[];
}

/**
 * Runs the tenant's configured patterns over the text of a memory file.
 *
 * The same `SecretScanner` the ingest pipeline runs over an uploaded
 * transcript, with the same `redactionPatterns(settings)` — a tenant that
 * turned `emailScan` on means it here too, and hardcoding SECRET_PATTERNS a
 * second time is how the setting came to be ignored the first time.
 */
export function scanMemoryText(text: string, settings: RedactionSettingsRecord): MemoryScanResult {
  const findings = scanner.scan(Buffer.from(text, "utf8"), redactionPatterns(settings));
  return {
    redactionStatus: findings.length ? "findings" : "clear",
    redactionFindings: findings.map((finding) => finding.kind),
  };
}

/**
 * Whether this document may be read out of the archive by something other than
 * its owner's own eyes.
 *
 * Reading your own memory file in your own web app is not egress: it is the
 * only way the review can happen at all. What this guards is text going to a
 * caller that will relay it onwards without a person in the loop — an MCP
 * client packing it into a model's context, a share, an export. Those are the
 * paths where "nobody re-reads a memory file before sharing it" stops being a
 * habit and becomes a leak.
 */
export function mayLeaveArchive(document: Pick<MemoryDocument, "redactionStatus">): boolean {
  return document.redactionStatus !== "findings";
}

/** Refuses egress in the vocabulary sharing a session already uses. */
export function requireReviewed(document: MemoryDocument): void {
  if (mayLeaveArchive(document)) return;
  throw new ConflictException({
    type: "https://memoar.dev/problems/redaction-review-required",
    title: "Redaction review required",
    status: 409,
    code: "redaction_review_required",
    documentId: document.id,
    path: document.path,
    redactionFindings: document.redactionFindings,
    detail: "The secret scanner found something in this memory file. A person has to review it before its text can be read outside the archive.",
  });
}
