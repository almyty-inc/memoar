import type { Session } from "../../canonical/src/generated.js";

export type SessionSeed = Omit<Session, "turns">;

export interface ParseRequest {
  source: string;
  version: string;
  raw: Uint8Array;
  seed: SessionSeed;
}

/** A single artifact can hold zero, one, or many native sessions. */
export type ParseResult =
  | { kind: "parsed"; parser: string; sessions: Session[] }
  | { kind: "unknown"; diagnostic: string; raw: Uint8Array };

export interface VersionedParser {
  readonly source: string;
  readonly versions: readonly string[];
  parse(request: ParseRequest): ParseResult;
}
