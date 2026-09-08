import type { Session } from "../../canonical/src/generated.js";
import { isRecord, isUuid } from "./common.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

/**
 * The first id in a bundle that a uuid column would refuse, if there is one.
 *
 * Checked here rather than left to the database, which reports one id at a time
 * from inside a failed transaction and says nothing about which session it
 * belonged to.
 */
function firstUnstorableId(sessions: readonly Session[]): string | null {
  for (const session of sessions) {
    if (!isUuid(session.id)) return `session ${session.id}`;
    for (const turn of session.turns ?? []) {
      if (!isUuid(turn.id)) return `turn ${turn.id}`;
      if (turn.parentId && !isUuid(turn.parentId)) return `turn parent ${turn.parentId}`;
      for (const block of turn.blocks ?? []) {
        if (!isUuid(block.id)) return `block ${block.id}`;
      }
    }
  }
  return null;
}

/** Memoar's own export format: canonical sessions round-trip byte-exact. */
export class CanonicalBundleParser implements VersionedParser {
  readonly source = "canonical-bundle";
  readonly versions = ["v1"] as const;

  parse(request: ParseRequest): ParseResult {
    try {
      const input = JSON.parse(Buffer.from(request.raw).toString("utf8")) as unknown;
      if (!isRecord(input) || typeof input.memoarBundle !== "string" || !Array.isArray(input.sessions)) {
        return { kind: "unknown", diagnostic: "canonical-bundle requires memoarBundle version and a sessions array", raw: request.raw };
      }
      const sessions = structuredClone(input.sessions) as Session[];
      // Every other parser derives a storable id when its source does not use
      // uuids. This one must not: a bundle is memoar's own export, and the
      // point of re-importing one is that a session keeps the identity it had.
      // Deriving new ids here would silently renumber an archive being moved
      // between deployments, so an id that cannot be stored is a bad bundle and
      // is refused while the raw bytes are still kept.
      const offending = firstUnstorableId(sessions);
      if (offending) {
        return { kind: "unknown", diagnostic: `canonical-bundle contains an id that is not a uuid: ${offending}`, raw: request.raw };
      }
      return {
        kind: "parsed",
        parser: `canonical-bundle:v1:${input.memoarBundle}`,
        sessions,
      };
    } catch {
      return { kind: "unknown", diagnostic: "canonical-bundle payload is not valid JSON", raw: request.raw };
    }
  }
}
