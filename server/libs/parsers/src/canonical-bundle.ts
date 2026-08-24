import type { Session } from "../../canonical/src/generated.js";
import { isRecord } from "./common.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

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
      return {
        kind: "parsed",
        parser: `canonical-bundle:v1:${input.memoarBundle}`,
        sessions: structuredClone(input.sessions) as Session[],
      };
    } catch {
      return { kind: "unknown", diagnostic: "canonical-bundle payload is not valid JSON", raw: request.raw };
    }
  }
}
