import type { DataSource, EntityManager, ObjectLiteral, SelectQueryBuilder } from "typeorm";
import type { TenantContext } from "../context.js";

export class TenantScope {
  static apply<T extends ObjectLiteral>(
    query: SelectQueryBuilder<T>,
    alias: string,
    context: TenantContext,
  ): SelectQueryBuilder<T> {
    return query.andWhere(`${alias}.tenantId = :tenantId`, { tenantId: context.tenantId });
  }
}

/**
 * Runs store operations inside a transaction with the tenant RLS setting
 * applied. Every tenant-scoped Postgres store shares one runner instance.
 */
export class TenantRunner {
  constructor(readonly dataSource: DataSource) {}

  async inTenant<T>(context: TenantContext, operation: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query("SELECT set_config('memoar.tenant_id', $1, true)", [context.tenantId]);
      return operation(manager);
    });
  }
}

export function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(value: string): { updatedAt: Date; id: string } | null {
  const [updatedAt, id] = Buffer.from(value, "base64url").toString("utf8").split("|");
  if (!updatedAt || !id) return null;
  const parsed = new Date(updatedAt);
  return Number.isNaN(parsed.valueOf()) ? null : { updatedAt: parsed, id };
}
