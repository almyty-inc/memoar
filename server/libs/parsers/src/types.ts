import type { Session } from "../../canonical/src/generated.js";

export type SessionSeed = Omit<Session, "turns">;

/**
 * The workspace of a session whose source records none.
 *
 * The contract requires a non-empty path, and the seed used to fill it with
 * the path of the captured file, so 655 Antigravity sessions on dev showed
 * `…/brain/<id>/.system_generated/logs/transcript.jsonl` as their project. A
 * transcript file is not a working directory. This value is not a path on any
 * machine, and the clients show it as "No workspace". `/memoar/imports`, which
 * uploads were given before, means the same and is recognised too.
 */
export const NO_WORKSPACE = "/memoar/no-workspace";

/** Workspace paths that stand for "none recorded". */
export const NO_WORKSPACE_PATHS: readonly string[] = [NO_WORKSPACE, "/memoar/imports"];

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
