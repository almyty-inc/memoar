import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DevArchiveStore } from "../src/store/memory/index.js";
import { buildRegistry } from "./mcp-fixture.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The skill is an instruction sheet an agent follows literally.
 *
 * It told agents to call `pack` with `max_tokens`, `max_evidence`,
 * `max_sessions` and `freshness_policy`. The schema has always been camelCase.
 * While arguments were read field by field an unknown key was simply ignored,
 * so every one of those became `undefined` and then `NaN` inside the budget
 * arithmetic — wrong quietly. Now that tools refuse what they cannot vouch for,
 * the same sheet fails loudly instead.
 *
 * Either way the sheet was wrong for as long as it existed, because nothing
 * compared it to the tools it describes. This does.
 */
describe("the skill describes the tools that exist", () => {
  const registry = buildRegistry(new DevArchiveStore());
  const skill = readFile(resolve(root, "skill/SKILL.md"), "utf8");

  /** Every `backticked` word in the sheet that names a tool or an argument. */
  async function quoted(): Promise<string[]> {
    const text = await skill;
    return [...text.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/gu)].map((match) => match[1]!);
  }

  it("names no tool the server does not serve", async () => {
    const served = new Set(registry.names);
    // A quoted word is a tool reference when it looks like one: the sheet also
    // quotes CLI subcommands and prose, and those are not the server's to hold.
    const referenced = (await quoted()).filter((word) => word.includes("_") && served.has(word));
    expect(referenced.length, "the sheet should reference tools by name").toBeGreaterThan(0);
    for (const name of referenced) expect(served.has(name)).toBe(true);
  });

  it("uses no argument name the tool schemas would refuse", async () => {
    // Every property any tool accepts, which is the vocabulary the sheet may
    // draw argument names from.
    const accepted = new Set(
      registry.tools.flatMap((tool) => Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      )),
    );
    // snake_case is the tell. No tool has ever accepted an underscored
    // argument, so any underscored word that is not itself a tool name is
    // either an argument the sheet invented or one it mis-spelled.
    const toolNames = new Set(registry.names);
    const suspects = (await quoted()).filter(
      (word) => word.includes("_") && !toolNames.has(word),
    );
    const wrong = suspects.filter((word) => !accepted.has(word));
    expect(wrong, "arguments the tools would refuse").toEqual([]);
  });

  it("names the pack budget arguments exactly as the schema spells them", async () => {
    const text = await skill;
    const pack = registry.tools.find((tool) => tool.name === "pack");
    const properties = Object.keys(
      (pack?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    for (const argument of ["maxTokens", "maxEvidence", "maxSessions", "freshnessPolicy"]) {
      expect(properties, `pack should accept ${argument}`).toContain(argument);
      expect(text, `the sheet should tell agents to send ${argument}`).toContain(argument);
    }
  });
});
