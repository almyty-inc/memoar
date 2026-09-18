import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ParserRegistry } from "../libs/parsers/src/index.js";
import { knownSourceLabels, sourceLabel } from "../src/source-labels.js";
import { connectorTable } from "./helpers/connector-table.js";

describe("what each source is called", () => {
  it("names every source the archive can parse", () => {
    // A source without a name was title-cased from its id, so kilo showed as
    // "Kilo" and antigravity-cli as "Antigravity Cli" — names invented by a
    // string transform. A new parser must bring its tool's name with it.
    const parsable = Object.keys(new ParserRegistry().capabilities());
    const unnamed = parsable.filter((source) => sourceLabel(source) === source);
    expect(unnamed, "these sources have no display name").toEqual([]);
  });

  it("uses the names the capture agent uses, not near-misses", async () => {
    // The agent's connector table is where these names come from; two tables
    // disagreeing means the same tool is called two things in one product.
    const connectors = await connectorTable();
    const captured = [...connectors.matchAll(/id: "([a-z0-9-]+)",\s*\n\s*display_name: "([^"]+)"/gu)];
    expect(captured.length, "no capture sources were found; has the table moved?").toBeGreaterThan(5);

    const disagreements = captured
      .map(([, id, name]) => ({ id: id!, agent: name!, server: sourceLabel(id!) }))
      .filter((entry) => entry.agent !== entry.server);
    expect(disagreements, "the agent and the archive call these different things").toEqual([]);
  });

  it("matches the copy the web client keeps", async () => {
    // The client needs names for ids that arrive without one — machine sources,
    // search buckets — so it carries the same table. Two tables of display
    // names is one too many, and only safe while something compares them.
    const client = await readFile(resolve(process.cwd(), "../web/src/lib/source-labels.ts"), "utf8");
    const table = client.slice(client.indexOf("= {") + 3, client.indexOf("};"));
    const labels = Object.fromEntries(
      [...table.matchAll(/'?([a-z0-9-]+)'?\s*:\s*'([^']+)'/gu)].map((match) => [match[1]!, match[2]!]),
    );
    expect(Object.keys(labels).length, "the client table could not be read").toBeGreaterThan(5);

    const mismatched = Object.entries(labels).filter(([id, name]) => sourceLabel(id) !== name);
    expect(mismatched, "the client and the archive call these different things").toEqual([]);
    expect(Object.keys(labels).sort()).toEqual([...knownSourceLabels()].sort());
  });

  it("hands back an id it does not know rather than dressing it up", () => {
    expect(sourceLabel("some-new-agent")).toBe("some-new-agent");
    expect(knownSourceLabels().length).toBeGreaterThan(10);
  });
});
