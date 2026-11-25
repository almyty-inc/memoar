import type { Session } from "../../canonical/src/generated.js";

export type SessionSeed = Omit<Session, "turns">;

export interface ParseRequest {
  source: string;
  version: string;
  raw: Uint8Array;
  seed: SessionSeed;
}

/**
 * A single artifact can hold zero, one, or many native sessions.
 *
 * `empty` is a file the parser read in full and found no conversation in, by
 * the tool's own structure: a Copilot panel whose `requests` is `[]`, a Codex
 * guardian thread holding only an encrypted compaction. It is a terminal,
 * expected outcome, where `unknown` is bytes the parser could not read and a
 * later parser might. Only `unknown` means capture or a parser is wrong.
 */
export type ParseResult =
  | { kind: "parsed"; parser: string; sessions: Session[] }
  | { kind: "empty"; parser: string; diagnostic: string }
  | { kind: "unknown"; diagnostic: string; raw: Uint8Array };

export interface VersionedParser {
  readonly source: string;
  readonly versions: readonly string[];
  parse(request: ParseRequest): ParseResult;
}
