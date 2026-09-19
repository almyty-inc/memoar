import { createHash } from "node:crypto";
import type { ArchivedSession } from "./context.js";

/**
 * Digest of the content a redaction review was completed against.
 *
 * Lives beside the stores rather than in the sharing service because it is not
 * only the mint-time gate: the store has to ask the same question when a
 * transfer is accepted, which happens entirely inside the store and in the
 * recipient's request. Two functions computing "the content that was reviewed"
 * would be two answers the moment one of them learned about a new field.
 */
export function sessionContentDigest(session: ArchivedSession): string {
  const captured = {
    id: session.id,
    updatedAt: session.updatedAt,
    turns: session.turns,
    redactionStatus: session.redactionStatus,
  };
  return createHash("sha256").update(JSON.stringify(captured)).digest("hex");
}
