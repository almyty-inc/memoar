/**
 * Groups errors that are the same failure.
 *
 * Two things make this necessary. The first is that a log line per error
 * answers "what happened to this request" and never "which of these is one
 * problem happening a thousand times, and which is a thousand problems".
 *
 * The second is privacy, and it is the reason the normalisation below is not
 * merely a convenience. Error messages quote their input. A real one from this
 * archive read
 *
 *     invalid input syntax for type uuid: "0191cafe-0000-7000-8000-0000000take0e"
 *
 * — a value out of somebody's transcript, sitting in a message that an operator
 * would reasonably paste into a chat window. Anything with a number, a quoted
 * literal or an identifier in it can carry content out of the archive, so the
 * variable parts are replaced before the message is kept anywhere, and what is
 * stored is the shape of the failure rather than the failure's data.
 */

import { createHash } from "node:crypto";

/** Where this repository's own frames live, as they appear in a stack. */
const OWN_FRAME = /at\s+(?:async\s+)?([\w.<>[\]]+)?\s*\(?(?:file:\/\/)?[^\s)]*\/(?:src|libs)\/([^\s):]+):(\d+)/u;

/**
 * Strips everything variable out of a message.
 *
 * Order matters: quoted literals go first, because they are the most likely to
 * hold archive content and the least likely to distinguish one failure from
 * another.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/"[^"]*"/gu, '"?"')
    .replace(/'[^']*'/gu, "'?'")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "<uuid>")
    .replace(/\b[0-9a-f]{32,}\b/giu, "<hash>")
    .replace(/\/[^\s"']*\//gu, "<path>/")
    .replace(/\b\d+\b/gu, "<n>")
    .trim()
    .slice(0, 200);
}

/** The first frame inside this codebase: where the failure actually is. */
export function originFrame(stack: string | undefined): string | null {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const match = OWN_FRAME.exec(line);
    if (match) return `${match[2]}:${match[3]}`;
  }
  return null;
}

export interface Fingerprint {
  /** Stable id for this kind of failure. */
  id: string;
  /** Error class, e.g. `QueryFailedError`. */
  type: string;
  /** The message with its variable parts removed. Safe to store and show. */
  shape: string;
  /** `file:line` inside this repository, when the stack reached it. */
  origin: string | null;
}

export function fingerprint(error: unknown): Fingerprint {
  const type = error instanceof Error ? error.constructor.name : typeof error;
  const raw = error instanceof Error ? error.message : String(error);
  const shape = normalizeMessage(raw);
  const origin = originFrame(error instanceof Error ? error.stack : undefined);
  // Origin is part of the identity: the same message thrown from two places is
  // two problems, and fixing one of them should not make the other disappear
  // from the list.
  const id = createHash("sha256").update(`${type}\n${shape}\n${origin ?? ""}`).digest("hex").slice(0, 16);
  return { id, type, shape, origin };
}
