import type { Annotation, AnnotationKind } from "../../../libs/canonical/src/generated.js";
import { AnnotationEntity } from "../../entities.js";
import { uuidV7 } from "../../ids.js";
import type { TenantContext } from "../context.js";
import type { AnnotationStore } from "../interfaces.js";
import { TenantRunner } from "./runner.js";
import type { PostgresSessionStore } from "./sessions.js";

/**
 * How many annotation rows go into one statement.
 *
 * Postgres refuses a statement carrying more than 65535 bind parameters, and
 * these rows have seven columns, so roughly nine thousand is the ceiling. A
 * thousand keeps a wide margin and bounds how much of the statement is held in
 * memory at once, which matters because the rows this writes come one per
 * credential found in a transcript and nothing bounds how many that is.
 */
const ANNOTATION_INSERT_BATCH = 1000;

function toAnnotation(row: AnnotationEntity): Annotation {
  return {
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    value: row.value,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.turnId ? { turnId: row.turnId } : {}),
    ...(row.blockId ? { blockId: row.blockId } : {}),
  };
}

export class PostgresAnnotationStore implements AnnotationStore {
  constructor(private readonly runner: TenantRunner, private readonly sessions: PostgresSessionStore) {}

  async listAnnotations(context: TenantContext, sessionId?: string): Promise<Annotation[]> {
    return this.runner.inTenant(context, async (manager) => {
      const where = sessionId ? { tenantId: context.tenantId, sessionId } : { tenantId: context.tenantId };
      const rows = await manager.getRepository(AnnotationEntity).find({ where, order: { createdAt: "ASC" } });
      return rows.map(toAnnotation);
    });
  }

  async createAnnotation(
    context: TenantContext,
    input: Parameters<AnnotationStore["createAnnotation"]>[1],
  ): Promise<Annotation> {
    return this.runner.inTenant(context, async (manager) => {
      if (!await this.sessions.getSessionWithManager(manager, context, input.sessionId)) throw new Error("session_not_found");
      const repository = manager.getRepository(AnnotationEntity);
      const row = await repository.save(repository.create({
        id: uuidV7(),
        tenantId: context.tenantId,
        sessionId: input.sessionId,
        turnId: input.turnId ?? null,
        blockId: input.blockId ?? null,
        kind: input.kind,
        value: input.value,
      }));
      return toAnnotation(row);
    });
  }

  async replaceAnnotations(
    context: TenantContext,
    sessionId: string,
    kind: AnnotationKind,
    values: Record<string, unknown>[],
    origin?: string,
  ): Promise<Annotation[]> {
    return this.runner.inTenant(context, async (manager) => {
      const repository = manager.getRepository(AnnotationEntity);
      // One delete and one multi-row insert, whatever the count: the delete has
      // to happen even when there is nothing to write, or a session that was
      // cleaned up keeps the findings from the capture before it.
      //
      // Narrowed to one producer's own rows when it names itself, so re-running
      // the scanner cannot take a person's hand-placed masks with it.
      if (origin === undefined) await repository.delete({ tenantId: context.tenantId, sessionId, kind });
      else await manager.createQueryBuilder().delete().from(AnnotationEntity)
        .where(`"tenantId" = :tenantId AND "sessionId" = :sessionId AND kind = :kind AND value->>'origin' = :origin`,
          { tenantId: context.tenantId, sessionId, kind, origin })
        .execute();
      if (values.length === 0) return [];
      const rows = values.map((value) => repository.create({
        id: uuidV7(),
        tenantId: context.tenantId,
        sessionId,
        turnId: null,
        blockId: null,
        kind,
        value: origin === undefined ? value : { ...value, origin },
      }));
      /*
        In batches, because "whatever the count" was not true.

        A transcript that leaks a credential on many lines produces one finding
        per line, and this saved them as a single statement. Two ceilings sit
        under that. Postgres refuses more than 65535 bind parameters in one
        statement, and these rows carry seven columns each, so about nine
        thousand findings is the hard limit. Below that, TypeORM builds the
        statement by spreading the parameter list, and a spread of a large
        array throws `Maximum call stack size exceeded` — which is not a depth
        problem and does not go away with a bigger stack.

        It surfaced as whole parses failing: seven artifacts, 470 MB of real
        transcripts, recorded as `parse failed: Maximum call stack size
        exceeded`, with the session, its turns and its blocks all lost over the
        annotation write that came after them.
      */
      let saved: AnnotationEntity[] = [];
      for (let index = 0; index < rows.length; index += ANNOTATION_INSERT_BATCH) {
        // concat rather than push(...batch): the fix is about not spreading
        // arrays whose length nothing bounds, and repeating the shape here —
        // even at a safe size — is how the next person learns the wrong lesson.
        saved = saved.concat(await repository.save(rows.slice(index, index + ANNOTATION_INSERT_BATCH)));
      }
      return saved.map(toAnnotation);
    });
  }

  async updateAnnotation(context: TenantContext, annotationId: string, value: Record<string, unknown>): Promise<Annotation | null> {
    return this.runner.inTenant(context, async (manager) => {
      const repository = manager.getRepository(AnnotationEntity);
      const row = await repository.findOneBy({ id: annotationId, tenantId: context.tenantId });
      if (!row) return null;
      row.value = value;
      return toAnnotation(await repository.save(row));
    });
  }

  async deleteAnnotation(context: TenantContext, annotationId: string): Promise<boolean> {
    return this.runner.inTenant(context, async (manager) => (await manager.getRepository(AnnotationEntity)
      .delete({ id: annotationId, tenantId: context.tenantId })).affected === 1);
  }
}
