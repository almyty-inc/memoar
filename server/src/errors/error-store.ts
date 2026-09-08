/**
 * Keeps the error groups across a restart.
 *
 * Without this the list answers "what has been failing since the last deploy",
 * which is the wrong question during the week after a deploy — the failure you
 * want to look up is usually the one that made you restart.
 *
 * A file rather than the archive, for the reason the aggregator is in memory at
 * all: writing failures to Postgres puts database writes on the failure path,
 * which is the one moment the database may be what is broken. A flush on a
 * timer is not on that path.
 *
 * What is written is what `snapshot()` returns — normalised shapes, never raw
 * messages — so the file cannot carry archive content out of the process even
 * if somebody copies it somewhere careless. A test holds that.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logLine } from "../observability.js";
import type { ErrorGroup } from "./error-aggregator.js";

export interface PersistedErrors {
  groups: ErrorGroup[];
  dropped: number;
  savedAt: string;
}

/**
 * Writes the state where it will survive the process.
 *
 * Written to a temporary name and renamed over the target, because rename is
 * atomic: a crash halfway through a write would otherwise leave a truncated
 * file that fails to parse on the next boot, and the error list would be
 * emptied by the very restart it exists to survive.
 */
export function writeErrorState(path: string, state: PersistedErrors): void {
  const temporary = `${path}.writing`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, JSON.stringify(state), "utf8");
  renameSync(temporary, path);
}

/**
 * Reads the state back, or nothing.
 *
 * Any problem — no file, unreadable, half-written, written by a version that
 * shaped it differently — is an empty result rather than a throw. This is the
 * component that reports failures; it must not be able to become one that
 * stops the service from starting.
 */
export function readErrorState(path: string): PersistedErrors | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const state = parsed as Partial<PersistedErrors>;
    if (!Array.isArray(state.groups)) return null;
    return {
      groups: state.groups.filter(isGroup),
      dropped: typeof state.dropped === "number" ? state.dropped : 0,
      savedAt: typeof state.savedAt === "string" ? state.savedAt : new Date(0).toISOString(),
    };
  } catch (error) {
    // Worth a line: an operator looking at an empty error list deserves to know
    // whether nothing has failed or the state could not be read.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logLine({ level: "warn", event: "error_state_unreadable", path, message: error instanceof Error ? error.message : String(error) });
    }
    return null;
  }
}

function isGroup(value: unknown): value is ErrorGroup {
  if (typeof value !== "object" || value === null) return false;
  const group = value as Partial<ErrorGroup>;
  return typeof group.id === "string" && typeof group.type === "string"
    && typeof group.shape === "string" && typeof group.count === "number"
    && typeof group.firstSeen === "string" && typeof group.lastSeen === "string";
}
