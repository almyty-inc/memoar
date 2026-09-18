import { describe, expect, it } from "vitest";
import { ParserRegistry } from "../libs/parsers/src/index.js";
import { connectorTable } from "./helpers/connector-table.js";

/**
 * Formats the server can import but no agent captures: they arrive as an upload
 * the user chose, not as a file found on a machine.
 */
const IMPORT_ONLY = new Set(["canonical-bundle", "cass-export", "chatgpt-export"]);

/**
 * The capture agent and the parser registry are two halves of one product, and
 * nothing connected them. Each was written from the same wish-list of tools and
 * they drifted: the agent collected files from twenty-three tools while the
 * server could parse eleven of them. Every file from the other twelve was
 * uploaded, stored, and marked unknown_format — work done on the user's machine
 * and bandwidth for an artifact that could never become a session.
 *
 * Reading the agent's own source table is blunt, but it is the only thing that
 * makes the two halves disagree loudly instead of silently.
 */
describe("the agent and the server agree on what is supported", () => {
  it("captures nothing the server cannot parse", async () => {
    const connectors = await connectorTable();
    const captured = [...connectors.matchAll(/^\s*id: "([a-z0-9-]+)",$/gmu)].map((match) => match[1]!);
    expect(captured.length, "no capture sources were found; has the table moved?").toBeGreaterThan(0);

    const parsable = new Set(Object.keys(new ParserRegistry().capabilities()));
    const uncapturable = captured.filter((source) => !parsable.has(source));
    expect(uncapturable, "the agent collects these but the server cannot parse them").toEqual([]);
  });

  it("parses nothing that no agent captures and no user can upload", async () => {
    const connectors = await connectorTable();
    const captured = new Set([...connectors.matchAll(/^\s*id: "([a-z0-9-]+)",$/gmu)].map((match) => match[1]!));
    const orphaned = Object.keys(new ParserRegistry().capabilities())
      .filter((source) => !captured.has(source) && !IMPORT_ONLY.has(source));
    expect(orphaned, "these parsers have no source: either capture them or drop them").toEqual([]);
  });
});
