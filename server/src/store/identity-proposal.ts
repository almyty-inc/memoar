import { uuidV7 } from "../ids.js";

/** The proposals in the order they were offered, a single one included. */
export function proposalList(proposed: string | readonly string[]): readonly string[] {
  return typeof proposed === "string" ? [proposed] : proposed;
}

/**
 * The first proposed session id that no other identity holds.
 *
 * The pipeline proposes the session an artifact was linked to last time,
 * because a re-parse should land where the first parse did. That stops being
 * true when a parser learns to tell two conversations apart that it used to
 * merge: Claude Code subagent transcripts were all filed under their parent's
 * session, and re-parsing one under its own identity proposed the parent's
 * session id again, which would have merged it straight back. A proposal some
 * other identity already holds is therefore skipped. A fresh id is the answer
 * when every proposal is taken, because merging is the one wrong answer.
 */
export function firstUnheld(proposed: string | readonly string[], held: ReadonlySet<string>): string {
  return proposalList(proposed).find((sessionId) => !held.has(sessionId)) ?? uuidV7();
}
