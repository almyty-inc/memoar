import { deniedReason, notATranscriptReason } from "./never-captured.js";

/**
 * One pass over the stored artifacts that never became a session.
 *
 * Two jobs, both safe to run again. Artifacts that should never have been
 * captured (key files, `.git` internals, `.DS_Store`, memory markdown and the
 * other files the capture agent swept up before its patterns were applied)
 * lose their row and their bytes. Every other `unknown_format` artifact is
 * handed back to the pipeline, so a detector or parser fixed since it was
 * refused gets another look. A second run finds nothing left to delete, and
 * re-parsing an artifact that is still refused only rewrites its diagnostic.
 *
 * Nothing that produced a session is touched, whatever its path says.
 */

export interface CleanupArtifact {
  id: string;
  tenantId: string;
  sha256: string;
  objectKey: string;
  status: string;
  source: string;
  sourcePath: string | null;
  size: number;
  capturedAt: string;
  /** Sessions this artifact produced, from `artifact_sessions`. */
  sessionCount: number;
}

/** Who an artifact's sessions belong to, and which machine sent it. */
export interface ArtifactOrigin {
  userId: string;
  machineId: string;
}

export interface CleanupStore {
  tenantIds(): Promise<string[]>;
  artifacts(tenantId: string): Promise<CleanupArtifact[]>;
  /**
   * The raw row does not record its uploader, so this is read off the parsed
   * artifact captured nearest in time in the same tenant: the same sync, in
   * every case seen on dev. Null when the tenant has no parsed artifact.
   */
  origin(artifact: CleanupArtifact): Promise<ArtifactOrigin | null>;
  /** Removes the artifact's row, and its session joins if any are left. */
  remove(artifact: CleanupArtifact): Promise<void>;
}

export interface ObjectRemover {
  delete(objectKey: string): Promise<void>;
}

/**
 * Re-runs detection and parsing and says what the artifact became. In a dry
 * run it parses nothing and says what it would do, including whose session it
 * would be.
 */
export type Reparse = (artifact: CleanupArtifact, apply: boolean) => Promise<string>;

export type Verdict =
  | { action: "delete"; reason: string }
  | { action: "reparse" }
  | { action: "keep" };

export function judge(artifact: CleanupArtifact): Verdict {
  if (artifact.sessionCount > 0 || artifact.status === "parsed") return { action: "keep" };
  if (artifact.sourcePath) {
    const denied = deniedReason(artifact.sourcePath);
    if (denied) return { action: "delete", reason: denied };
  }
  if (artifact.status !== "unknown_format") return { action: "keep" };
  const stray = artifact.sourcePath ? notATranscriptReason(artifact.source, artifact.sourcePath) : null;
  return stray ? { action: "delete", reason: stray } : { action: "reparse" };
}

export interface CleanupLine {
  tenantId: string;
  sha256: string;
  source: string;
  sourcePath: string | null;
  size: number;
  action: "delete" | "reparse";
  reason?: string;
  /** What happened: `would delete`, `deleted`, the new status, or an error. */
  outcome: string;
}

export interface CleanupReport {
  mode: "dry-run" | "apply";
  deleted: { artifacts: number; bytes: number };
  reparsed: Record<string, number>;
  errors: number;
  lines: CleanupLine[];
}

export interface CleanupOptions {
  store: CleanupStore;
  objects: ObjectRemover;
  reparse: Reparse;
  apply: boolean;
  /** Only these tenants. Every tenant with artifacts when absent. */
  tenantIds?: string[];
}

export async function runCleanup(options: CleanupOptions): Promise<CleanupReport> {
  const report: CleanupReport = {
    mode: options.apply ? "apply" : "dry-run",
    deleted: { artifacts: 0, bytes: 0 },
    reparsed: {},
    errors: 0,
    lines: [],
  };
  const tenants = options.tenantIds ?? await options.store.tenantIds();
  for (const tenantId of tenants) {
    for (const artifact of await options.store.artifacts(tenantId)) {
      const verdict = judge(artifact);
      if (verdict.action === "keep") continue;
      const line: CleanupLine = {
        tenantId, sha256: artifact.sha256, source: artifact.source, sourcePath: artifact.sourcePath,
        size: artifact.size, action: verdict.action, outcome: "",
        ...(verdict.action === "delete" ? { reason: verdict.reason } : {}),
      };
      report.lines.push(line);
      try {
        line.outcome = verdict.action === "delete"
          ? await remove(options, artifact, report)
          : await reparse(options, artifact, report);
      } catch (error) {
        report.errors += 1;
        line.outcome = `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  return report;
}

/**
 * Bytes first, then the row. If the bytes go and the row does not, the next
 * run finds the row and deletes the already-absent object again, which
 * succeeds. The other order could leave bytes nothing points at any more.
 */
async function remove(options: CleanupOptions, artifact: CleanupArtifact, report: CleanupReport): Promise<string> {
  if (!options.apply) return "would delete";
  await options.objects.delete(artifact.objectKey);
  await options.store.remove(artifact);
  report.deleted.artifacts += 1;
  report.deleted.bytes += artifact.size;
  return "deleted";
}

async function reparse(options: CleanupOptions, artifact: CleanupArtifact, report: CleanupReport): Promise<string> {
  const status = await options.reparse(artifact, options.apply);
  if (options.apply) report.reparsed[status] = (report.reparsed[status] ?? 0) + 1;
  return status;
}
