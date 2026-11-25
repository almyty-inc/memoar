import type { RawArtifactRecord } from "./archive-store.js";

export interface ReprocessSelection {
  /** One artifact, by its digest. */
  sha256?: string | null;
  /** Only artifacts in this status, such as `stored` for uploads nothing ever parsed. */
  status?: string | null;
  /** Only artifacts linked to a session that more than one file writes to. */
  mergedSessions?: boolean;
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
  return artifacts
    .filter((artifact) => !selection.sha256 || artifact.sha256 === selection.sha256)
    .filter((artifact) => !selection.status || artifact.status === selection.status)
    .filter((artifact) => !merged || artifact.sessionIds.some((sessionId) => merged.has(sessionId)))
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt) || left.sha256.localeCompare(right.sha256));
}
