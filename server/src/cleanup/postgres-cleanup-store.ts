import type { DataSource, EntityManager } from "typeorm";
import type { ArtifactOrigin, CleanupArtifact, CleanupStore } from "./artifact-cleanup.js";

/** A row as Postgres returns it: bigint and count arrive as strings. */
type StoredRow = Omit<CleanupArtifact, "size" | "sessionCount"> & { size: string; sessionCount: string };

/**
 * The cleanup's reads and deletes, in the tenant's own row-security scope.
 *
 * Raw SQL rather than the archive store: deleting an artifact is not something
 * the archive does, and keeping it out of the store interface keeps it out of
 * every request path.
 */
export class PostgresCleanupStore implements CleanupStore {
  constructor(private readonly dataSource: DataSource) {}

  /** From auth_identities, as retention does: raw_artifacts is row-secured and shows nothing without a tenant. */
  async tenantIds(): Promise<string[]> {
    const rows = await this.dataSource.query<{ tenantId: string }[]>(`SELECT DISTINCT "tenantId" FROM auth_identities ORDER BY 1`);
    return rows.map((row) => row.tenantId);
  }

  artifacts(tenantId: string): Promise<CleanupArtifact[]> {
    return this.inTenant(tenantId, async (manager) => {
      const rows = await manager.query<StoredRow[]>(
        `SELECT r.id, r."tenantId", r.sha256, r."objectKey", r.status, r.source, r."sourcePath", r.size,
                to_json(r."capturedAt") #>> '{}' AS "capturedAt",
                (SELECT count(*) FROM artifact_sessions j WHERE j."tenantId" = r."tenantId" AND j."artifactId" = r.id) AS "sessionCount"
           FROM raw_artifacts r
          WHERE r."tenantId" = $1 AND r.status <> 'parsed'
          ORDER BY r."capturedAt", r.sha256`,
        [tenantId],
      );
      return rows.map((row) => ({ ...row, sha256: row.sha256.trim(), size: Number(row.size), sessionCount: Number(row.sessionCount) }));
    });
  }

  origin(artifact: CleanupArtifact): Promise<ArtifactOrigin | null> {
    return this.inTenant(artifact.tenantId, async (manager) => {
      const rows = await manager.query<Partial<ArtifactOrigin>[]>(
        `SELECT s.visibility->>'ownerId' AS "userId", s.source->>'machineId' AS "machineId"
           FROM raw_artifacts r
           JOIN artifact_sessions j ON j."tenantId" = r."tenantId" AND j."artifactId" = r.id
           JOIN sessions s ON s."tenantId" = r."tenantId" AND s.id = j."sessionId"
          WHERE r."tenantId" = $1 AND r.status = 'parsed' AND r."sourcePath" IS NOT NULL
          ORDER BY abs(extract(epoch FROM r."capturedAt" - $2::timestamptz)), r.sha256
          LIMIT 1`,
        [artifact.tenantId, artifact.capturedAt],
      );
      const row = rows[0];
      return row?.userId && row.machineId ? { userId: row.userId, machineId: row.machineId } : null;
    });
  }

  remove(artifact: CleanupArtifact): Promise<void> {
    return this.inTenant(artifact.tenantId, async (manager) => {
      await manager.query(`DELETE FROM artifact_sessions WHERE "tenantId" = $1 AND "artifactId" = $2`, [artifact.tenantId, artifact.id]);
      await manager.query(`DELETE FROM raw_artifacts WHERE "tenantId" = $1 AND id = $2`, [artifact.tenantId, artifact.id]);
    });
  }

  private inTenant<T>(tenantId: string, operation: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query("SELECT set_config('memoar.tenant_id', $1, true)", [tenantId]);
      return operation(manager);
    });
  }
}
