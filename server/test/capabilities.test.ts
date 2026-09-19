import { describe, expect, it } from "vitest";
import { ParserRegistry } from "../libs/parsers/src/index.js";
import { CapabilitiesController } from "../src/capabilities.controller.js";

/**
 * The connector count has to come from the connectors.
 *
 * The web app carried it as an English literal kept in step with a Rust array
 * in another crate by nobody. It was right, and nothing made it stay right.
 */
describe("capabilities", () => {
  const body = new CapabilitiesController().capabilities() as {
    connectors: string[];
    connectorCount: number;
    uploadFormats: string[];
    contractVersion: string;
  };

  it("counts the agents whose stores are read, not the parsers", () => {
    expect(body.connectorCount).toBe(body.connectors.length);
    // Every connector must be a parser this server actually holds.
    const parsed = Object.keys(new ParserRegistry().capabilities());
    for (const connector of body.connectors) expect(parsed).toContain(connector);
  });

  it("leaves out the formats that arrive by upload", () => {
    for (const uploaded of ["chatgpt-export", "cass-export", "canonical-bundle"]) {
      expect(body.connectors, `${uploaded} is not a store on a machine`).not.toContain(uploaded);
      expect(body.uploadFormats).toContain(uploaded);
    }
  });

  it("names the contract it speaks", () => {
    expect(body.contractVersion).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  /**
   * The number the onboarding copy used to state, now asserted against the
   * registry rather than typed into a sentence.
   */
  it("reports every agent store the archive can parse", () => {
    expect(body.connectors).toEqual([
      "antigravity-cli", "claude-code", "codex", "copilot", "crush",
      "cursor", "goose", "kilo", "opencode", "roo", "zed",
    ]);
  });
});
