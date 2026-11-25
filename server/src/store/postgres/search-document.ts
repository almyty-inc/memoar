import type { ArchivedSession } from "../context.js";

/**
 * Postgres refuses a tsvector built from more than 1 MiB of text, so the search
 * document has to be bounded before it is stored.
 *
 * Nothing bounded it. Four real transcripts in the dev archive produced search
 * documents of 1.3 MB, 2.6 MB, 10.4 MB and 13.0 MB, and each one failed its
 * whole parse with `string is too long for tsvector (10357378 bytes, max
 * 1048575 bytes)` — so the session, its turns and its blocks were all lost over
 * the search index, which is the least important thing being written. A session
 * you cannot find is worth more than no session at all.
 *
 * The cap is on the bytes Postgres counts, not the characters: multi-byte text
 * is exactly where this bites, and slicing by length would still overrun. The
 * cut lands on a character boundary because the text is sliced, never the
 * buffer.
 */
const MAX_SEARCH_DOCUMENT_BYTES = 1_000_000;

export function boundedSearchDocument(session: ArchivedSession): string {
  const whole = session.turns.flatMap((turn) => turn.blocks.map((block) => block.text ?? "")).join("\n");
  if (Buffer.byteLength(whole, "utf8") <= MAX_SEARCH_DOCUMENT_BYTES) return whole;
  // Narrow by characters until the bytes fit. One pass, because the ratio of
  // bytes to characters only ever shrinks as the string does.
  let kept = whole.slice(0, MAX_SEARCH_DOCUMENT_BYTES);
  while (Buffer.byteLength(kept, "utf8") > MAX_SEARCH_DOCUMENT_BYTES) {
    kept = kept.slice(0, Math.floor(kept.length * 0.9));
  }
  return kept;
}

