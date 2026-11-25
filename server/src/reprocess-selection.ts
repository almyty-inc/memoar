import { isStaleParserVersion } from "../libs/parsers/src/versions.js";
import type { RawArtifactRecord } from "./archive-store.js";
import type { SessionParse } from "./store/interfaces.js";

export interface ReprocessSelection {
  /** One artifact, by its digest. */
  sha256?: string | null;
  /** Only artifacts in this status, such as `stored` for uploads nothing ever parsed. */
  status?: string | null;
  /** Only artifacts linked to a session that more than one file writes to. */
  mergedSessions?: boolean;
  /**
   * Only parsed artifacts whose sessions an older parser wrote, by the
   * session's recorded parser version, and of those only the newest capture
   * of each session: re-parsing an older capture of a file that has grown
   * since is work the pipeline then throws away.
   *
   * With a machine, only sessions that machine captured. An artifact does not
   * record its machine, and a re-parse files its sessions under the machine
   * the run acts for, so a run per machine keeps every session where it was.
   */
  staleParser?: { sessions: ReadonlyMap<string, SessionParse>; machineId?: string | null } | null;
}

/** The newest capture of each session, by capture time. */
function newestCaptures(artifacts: readonly RawArtifactRecord[]): Set<string> {
  const newest = new Map<string, RawArtifactRecord>();
  for (const artifact of artifacts) {
    for (const sessionId of artifact.sessionIds) {
      const current = newest.get(sessionId);
      if (!current || Date.parse(artifact.capturedAt) > Date.parse(current.capturedAt)) newest.set(sessionId, artifact);
    }
  }
  return new Set([...newest.values()].map((artifact) => artifact.sha256));
}

function isStale(artifact: RawArtifactRecord, stale: NonNullable<ReprocessSelection["staleParser"]>): boolean {
  if (artifact.status !== "parsed" || artifact.sessionIds.length === 0) return false;
  const sessions = artifact.sessionIds.map((sessionId) => stale.sessions.get(sessionId));
  // Every session the artifact wrote has to belong to the machine, or the run
  // would move the others onto it.
  if (stale.machineId && !sessions.every((session) => session?.machineId === stale.machineId)) return false;
  return sessions.some((session) => session !== undefined && isStaleParserVersion(session.parserVersion, artifact.source));
}

/**
 * Sessions written by more than one file.
 *
 * One file is one conversation, so a session two different capture paths
 * resolve to is two conversations sharing a session, and the file parsed last
 * holds it. Claude Code subagent transcripts did exactly this, because they
 * name their parent's session id. Successive captures of one growing file share
 * a path and are not counted.
 */
export function mergedSessionIds(artifacts: readonly RawArtifactRecord[]): Set<string> {
  const paths = new Map<string, Set<string>>();
  for (const artifact of artifacts) {
    if (!artifact.sourcePath) continue;
    for (const sessionId of artifact.sessionIds) {
      const seen = paths.get(sessionId) ?? new Set<string>();
      seen.add(artifact.sourcePath);
      paths.set(sessionId, seen);
    }
  }
  return new Set([...paths].filter(([, seen]) => seen.size > 1).map(([sessionId]) => sessionId));
}

/**
 * The artifacts a reprocess run should parse, oldest capture first.
 *
 * Oldest first so that, even without the pipeline's own guard against stale
 * captures, the last write to every session is its newest capture.
 */
export function selectForReprocess(artifacts: readonly RawArtifactRecord[], selection: ReprocessSelection): RawArtifactRecord[] {
  const merged = selection.mergedSessions ? mergedSessionIds(artifacts) : null;
  const stale = selection.staleParser ?? null;
  const newest = stale ? newestCaptures(artifacts.filter((artifact) => artifact.status === "parsed")) : null;
  return artifacts
    .filter((artifact) => !stale || (isStale(artifact, stale) && newest!.has(artifact.sha256)))
    .filter((artifact) => !selection.sha256 || artifact.sha256 === selection.sha256)
    .filter((artifact) => !selection.status || artifact.status === selection.status)
    .filter((artifact) => !merged || artifact.sessionIds.some((sessionId) => merged.has(sessionId)))
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt) || left.sha256.localeCompare(right.sha256));
}
