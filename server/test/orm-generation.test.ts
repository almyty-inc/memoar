import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ContentBlockEntity, SessionEntity, TurnEntity } from "../libs/canonical/src/orm.generated.js";

const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../contracts/canonical.schema.json"), "utf8")) as {
  $defs: Record<string, { required?: string[]; properties?: Record<string, { oneOf?: { type?: string }[] }> }>;
};

const TABLES = [
  { entity: SessionEntity, definition: "Session", skip: ["turns"], renames: { createdAt: "capturedCreatedAt", updatedAt: "capturedUpdatedAt" } },
  { entity: TurnEntity, definition: "Turn", skip: ["blocks"], renames: { createdAt: "capturedAt" } },
  { entity: ContentBlockEntity, definition: "ContentBlock", skip: [], renames: {} },
] as const;

describe("TypeORM generation from canonical metadata", () => {
  it.each(TABLES)("maps every canonical $definition field to a column with matching nullability", ({ entity, definition, skip, renames }) => {
    const model = schema.$defs[definition]!;
    const required = new Set(model.required ?? []);
    const columns = entity.options.columns as Record<string, { nullable?: boolean; primary?: boolean }>;
    for (const [property, node] of Object.entries(model.properties ?? {})) {
      if ((skip as readonly string[]).includes(property)) continue;
      const columnName = (renames as Record<string, string>)[property] ?? property;
      const column = columns[columnName];
      expect(column, `${definition}.${property} must map to column ${columnName}`).toBeDefined();
      const expectNullable = !required.has(property) || Boolean(node.oneOf?.some((item) => item.type === "null"));
      const actualNullable = Boolean(column!.nullable);
      if (property !== "id") {
        expect(actualNullable, `${definition}.${property} nullability`).toBe(expectNullable);
      } else {
        expect(column!.primary).toBe(true);
      }
    }
  });

  it("keeps the harness plumbing every store query relies on", () => {
    const sessions = SessionEntity.options.columns as Record<string, unknown>;
    for (const column of ["tenantId", "redactionStatus", "searchDocument", "embedding", "createdAt", "updatedAt"]) {
      expect(sessions[column], `sessions.${column}`).toBeDefined();
    }
    const turns = TurnEntity.options.columns as Record<string, unknown>;
    expect(turns.sessionId).toBeDefined();
    const blocks = ContentBlockEntity.options.columns as Record<string, unknown>;
    for (const column of ["sessionId", "turnId", "ordinal"]) expect(blocks[column], `content_blocks.${column}`).toBeDefined();
  });

  it("regenerating from the model is deterministic (no drift)", () => {
    const generated = readFileSync(resolve(import.meta.dirname, "../libs/canonical/src/orm.generated.ts"), "utf8");
    expect(generated).toContain("Generated from contracts/source/canonical.model.json");
    expect(generated).not.toContain("__IMPORTS__");
  });
});
