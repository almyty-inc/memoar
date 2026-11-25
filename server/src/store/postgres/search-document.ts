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

/**
 * Characters of one block that the search document takes, by kind.
 *
 * Tool output became searchable when the parsers started keeping it, and it
 * is most of a transcript by volume: one `cat` of a lockfile is larger than
 * every word a person typed in the session. Taken whole, the first few tool
 * results filled the 1 MB cap and the conversation after them could not be
 * found at all. The head of each output is what a search for it usually
 * names (the command, the error, the file), so each output contributes that
 * much, and prose is taken whole.
 */
const PER_BLOCK_CHARACTERS: Readonly<Partial<Record<string, number>>> = {
  tool_result: 2_000,
  attachment: 2_000,
  system: 2_000,
  error: 2_000,
  thinking: 8_000,
};

function searchableText(kind: string, text: string | undefined): string {
  if (!text) return "";
  const cap = PER_BLOCK_CHARACTERS[kind];
  return cap !== undefined && text.length > cap ? text.slice(0, cap) : text;
}

export function boundedSearchDocument(session: ArchivedSession): string {
  const whole = session.turns
    .flatMap((turn) => turn.blocks.map((block) => searchableText(block.kind, block.text)))
    .filter((text) => text.length > 0)
    .join("\n");
  if (Buffer.byteLength(whole, "utf8") <= MAX_SEARCH_DOCUMENT_BYTES) return whole;
  // Narrow by characters until the bytes fit. One pass, because the ratio of
  // bytes to characters only ever shrinks as the string does.
  let kept = whole.slice(0, MAX_SEARCH_DOCUMENT_BYTES);
  while (Buffer.byteLength(kept, "utf8") > MAX_SEARCH_DOCUMENT_BYTES) {
    kept = kept.slice(0, Math.floor(kept.length * 0.9));
  }
  return kept;
}

