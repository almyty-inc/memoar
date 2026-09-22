/**
 * The tools as advertised, checked against the tools as implemented.
 *
 * A model chooses a tool by its description and builds the call from its
 * schema, so a description that overstates what a handler does, or a schema
 * that omits a constraint the DTO enforces, is a defect in its own right — the
 * model has no other way to find out. These assertions are on the surface
 * itself and need no archive behind them.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { buildRegistry } from "./mcp-fixture.js";

const tools = buildRegistry(new DevArchiveStore()).tools;

function schemaOf(name: string): Record<string, unknown> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool.inputSchema.properties ?? {};
}

it("discloses that project memory is gathered from a bounded window of sessions", () => {
  const description = tools.find((tool) => tool.name === "export_project_memory")!.description!;
  // `DistillationService.exportProjectMemory` reads `limit: 100` with no
  // cursor. "The distilled notes for one workspace" on its own is a
  // completeness claim that neither it nor this tool makes good on.
  expect(description).toContain("100 most recent sessions");
});

/*
  Every argument `skill/SKILL.md` tells an agent to send must exist.

  The skill is loaded into the model's context before any of these tools are
  called, so an argument named there and absent from the schema is a call that
  will be refused for as long as the two files disagree. It has happened twice:
  the skill asked for pack arguments in snake_case after the DTO had settled on
  camelCase, and it told agents to "link the note to the source session and
  exact turn span" when `save_note` takes no turn span at all —
  `parseToolArguments` refuses unknown fields, so an agent doing exactly what
  the skill said got `invalid_arguments:turnEnd,turnStart`.
*/
it("offers every argument skill/SKILL.md tells an agent to send", () => {
  const promised: Record<string, string[]> = {
    search_sessions: ["agent", "workspace", "from", "to"],
    list_sessions: ["machineId"],
    pack: ["maxTokens", "maxEvidence", "maxSessions", "freshnessPolicy"],
    save_note: ["sessionId", "markdown", "topic"],
    get_excerpt: ["sessionId", "turnStart", "turnEnd"],
  };
  for (const [name, fields] of Object.entries(promised)) {
    const properties = schemaOf(name);
    for (const field of fields) {
      expect(properties[field], `SKILL.md names ${name}.${field}, which the tool has not got`).toBeDefined();
    }
  }
  const skill = readFileSync(new URL("../../skill/SKILL.md", import.meta.url), "utf8");
  expect(skill, "save_note has no turn span; the skill must not send an agent looking for one")
    .toContain("there is no turn-span argument");
});

describe("id arguments", () => {
  it("declares uuid wherever the DTO enforces one", () => {
    const uuidFields = ["sessionId", "teamId", "collectionId", "machineId", "documentId", "turnId", "blockId"];
    for (const tool of tools) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, { format?: string }>;
      for (const field of uuidFields) {
        const property = properties[field];
        if (!property) continue;
        // `{ type: "string" }` for a field validated by `@IsUUID()` tells a
        // model any string will do, and it finds out otherwise one refused
        // call later.
        expect(property.format, `${tool.name}.${field} is validated as a uuid but advertised as any string`).toBe("uuid");
      }
    }
  });
});
