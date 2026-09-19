import type { EntityManager } from "typeorm";
import { ArtifactSessionEntity, RawArtifactEntity } from "../../entities.js";
import { uuidV7 } from "../../ids.js";
import type { TenantContext } from "../context.js";
import type { ArtifactStore } from "../interfaces.js";
import type { RawArtifactRecord } from "../records.js";
import { TenantRunner, TenantScope } from "./runner.js";

export class PostgresArtifactStore implements ArtifactStore {
  constructor(private readonly runner: TenantRunner) {}

  async saveRawArtifact(context: TenantContext, artifact: RawArtifactRecord): Promise<boolean> {
    return this.runner.inTenant(context, async (manager) => {
      const repository = manager.getRepository(RawArtifactEntity);
      if (await repository.existsBy({ tenantId: context.tenantId, sha256: artifact.sha256 })) return false;
      const { sessionIds, ...columns } = artifact;
      void sessionIds;
      await repository.save({
        ...columns,
        size: String(artifact.size),
        capturedAt: new Date(artifact.capturedAt),
      });
      return true;
    });
  }

  async updateRawArtifact(context: TenantContext, artifact: RawArtifactRecord): Promise<void> {
    await this.runner.inTenant(context, async (manager) => {
      await manager.getRepository(RawArtifactEntity).update(
        { tenantId: context.tenantId, sha256: artifact.sha256 },
        {
          status: artifact.status,
          diagnostic: artifact.diagnostic,
          objectKey: artifact.objectKey,
          sourcePath: artifact.sourcePath,
        },
      );
      const joins = manager.getRepository(ArtifactSessionEntity);
      await joins.delete({ tenantId: context.tenantId, artifactId: artifact.id });
      for (const sessionId of new Set(artifact.sessionIds)) {
        await joins.save({ id: uuidV7(), tenantId: context.tenantId, artifactId: artifact.id, sessionId });
      }
    });
  }

  private async sessionIdsFor(manager: EntityManager, context: TenantContext, artifactIds: readonly string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (!artifactIds.length) return map;
    const joins = await manager.getRepository(ArtifactSessionEntity)
      .createQueryBuilder("join")
      .where("join.tenantId = :tenantId", { tenantId: context.tenantId })
      .andWhere("join.artifactId IN (:...artifactIds)", { artifactIds })
      .orderBy("join.createdAt", "ASC")
      .getMany();
    for (const join of joins) {
      const list = map.get(join.artifactId) ?? [];
      list.push(join.sessionId);
      map.set(join.artifactId, list);
    }
    return map;
  }

  async getRawArtifact(context: TenantContext, sha256: string): Promise<RawArtifactRecord | null> {
    return this.runner.inTenant(context, async (manager) => {
      const row = await manager.getRepository(RawArtifactEntity).findOneBy({ tenantId: context.tenantId, sha256 });
      if (!row) return null;
      const joins = await this.sessionIdsFor(manager, context, [row.id]);
      return {
        ...row,
        sessionIds: joins.get(row.id) ?? [],
        size: Number(row.size),
        capturedAt: row.capturedAt.toISOString(),
      };
    });
  }

  async listArtifactHashes(context: TenantContext, hashes: readonly string[]): Promise<Set<string>> {
    if (!hashes.length) return new Set();
    return this.runner.inTenant(context, async (manager) => {
      const rows = await TenantScope.apply(manager.getRepository(RawArtifactEntity).createQueryBuilder("artifact"), "artifact", context)
        .select("artifact.sha256", "sha256").andWhere("artifact.sha256 IN (:...hashes)", { hashes }).getRawMany<{ sha256: string }>();
      return new Set(rows.map((row) => row.sha256));
    });
  }

  /**
   * What was collected and could not be read.
   *
   * An artifact the archive cannot parse is kept with its bytes and an
   * `unknown_format` diagnostic, on purpose: a parser written later can still
   * read it. What was missing is anyone being told. A capture pattern pointed
   * at the wrong directory — which has happened twice — produces exactly this
   * and nothing else, so a machine can sync happily for weeks while archiving
   * nothing anybody can read.
   *
   * Counted in the database rather than by listing every artifact, because the
   * answer is one row per tool and the question gets asked by `doctor`.
   */
  async countUnparsedArtifactsBySource(context: TenantContext): Promise<{ source: string; artifacts: number; diagnostic: string | null }[]> {
    // The diagnostic is the commonest one, not the alphabetically last.
    //
    // `max(diagnostic)` picks by sort order, which has nothing to do with how
    // often a reason occurs. On a real archive it chose a five-row "session
    // persistence failed: duplicate key" over the twelve-hundred-row "no parser
    // for claude-code@unknown" that was the actual story — so the one line a
    // person reads to find out why their capture is not being read pointed at a
    // database bug instead of at the pattern collecting the wrong files. A
    // count is a finding; so is the reason beside it.
    return this.runner.inTenant(context, async (manager) => manager.query(
      `WITH reasons AS (
         SELECT source, diagnostic, count(*)::int AS reason_count
           FROM raw_artifacts
          WHERE "tenantId" = $1 AND status IN ('unknown_format', 'failed')
          GROUP BY source, diagnostic
       )
       SELECT source,
              sum(reason_count)::int AS artifacts,
              -- Ties break by the reason itself, so the answer does not depend
              -- on the order rows happened to arrive in.
              (ARRAY_AGG(diagnostic ORDER BY reason_count DESC, diagnostic))[1] AS diagnostic
         FROM reasons
        GROUP BY source
        ORDER BY artifacts DESC`,
      [context.tenantId],
    ));
  }

  async listRawArtifacts(context: TenantContext): Promise<RawArtifactRecord[]> {
    return this.runner.inTenant(context, async (manager) => {
      const rows = await manager.getRepository(RawArtifactEntity).findBy({ tenantId: context.tenantId });
      const joins = await this.sessionIdsFor(manager, context, rows.map((row) => row.id));
      return rows.map((row) => ({
        ...row,
        sessionIds: joins.get(row.id) ?? [],
        size: Number(row.size),
        capturedAt: row.capturedAt.toISOString(),
      }));
    });
  }
}
