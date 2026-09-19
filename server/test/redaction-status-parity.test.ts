import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { RedactionStatus } from "../libs/canonical/src/generated.js";

/**
 * One list of redaction statuses, in three languages.
 *
 * `redactionStatus` is now a canonical field, which means the server writes it,
 * the Rust the capture agent is built from deserializes it, and the web app
 * decides what to render from it. Three lists, three languages, nothing
 * comparing them — which is exactly the shape of the bug that broke `memoar
 * login` in CI: two lists agreed to disagree and each side's own tests were
 * green. `capture-scopes.test.ts` is the pattern; this is the same idea for a
 * status value rather than for a scope.
 *
 * Adding a status to the contract and regenerating is enough to make this pass.
 * Adding one to only one side is what it is here to catch.
 */
const CANONICAL: RedactionStatus[] = ["clear", "findings", "reviewed"];

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(process.cwd(), relativePath), "utf8");
}

/** `Clear` in Rust is `clear` on the wire: the enum carries rename_all = "snake_case". */
function toWire(variant: string): string {
  return variant.replace(/(?<!^)([A-Z])/gu, "_$1").toLowerCase();
}

describe("the redaction statuses server, agent and web agree on", () => {
  it("are the ones the contract defines", async () => {
    const schema = JSON.parse(await read("../contracts/canonical.schema.json")) as {
      $defs: Record<string, { enum?: string[] }>;
    };
    expect(schema.$defs.RedactionStatus?.enum, "the contract is the source; has the definition moved?").toEqual(CANONICAL);
  });

  it("are the variants the agent's generated Rust can deserialize", async () => {
    const generated = await read("../agent/crates/memoar-canonical/src/generated.rs");
    const block = /pub enum RedactionStatus \{([^}]*)\}/u.exec(generated);
    expect(block, "RedactionStatus should be a generated Rust enum; has the generator changed?").not.toBeNull();
    const variants = [...block![1]!.matchAll(/^\s*([A-Za-z0-9]+),/gmu)].map((match) => toWire(match[1]!));
    expect(variants.length, "no variants were parsed; has the shape changed?").toBeGreaterThan(1);
    expect(variants, "the agent would fail to deserialize a document the server serves").toEqual(CANONICAL);
  });

  it("are the ones the web app knows how to render", async () => {
    // The badge is keyed by status. A status the archive can serve and the badge
    // has no label for renders as nothing at all, which is the page asserting
    // that a file has no redaction state when it has one.
    const types = await read("../web/src/lib/types.ts");
    const union = /export type RedactionStatus = ([^;]+);/u.exec(types);
    expect(union, "web/src/lib/types.ts should declare a RedactionStatus union").not.toBeNull();
    const known = [...union![1]!.matchAll(/'([a-z_]+)'/gu)].map((match) => match[1]!);
    expect(known).toEqual(CANONICAL);

    const ui = await read("../web/src/components/ui.tsx");
    const labels = /const labels: Record<RedactionStatus, string> = \{([^}]*)\}/u.exec(ui);
    expect(labels, "RedactionBadge should map every status to a label").not.toBeNull();
    const labelled = [...labels![1]!.matchAll(/^\s*([a-z_]+):/gmu)].map((match) => match[1]!);
    expect([...labelled].sort(), "a status with no label renders as an empty badge").toEqual([...CANONICAL].sort());
  });
});
