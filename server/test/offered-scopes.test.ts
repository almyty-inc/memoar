import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PASSWORD_SCOPES } from "../src/bootstrap-account.js";
import { KNOWN_SCOPES } from "../src/auth/scopes.js";

/**
 * A scope the web app offers must be one this server grants.
 *
 * The create-key form offered `sessions:read`, `collections:read`, `pack:read`
 * and `notes:write`. None of them exist. `createApiKey` stored whatever
 * arrived, so every key a person made in the browser carried four scopes no
 * route recognises and would have been refused by all of them — and the
 * browser acceptance test asserted a 201 and got one, because the server
 * accepted nonsense. The moment the server began validating, the form started
 * returning 400 and the defect finally showed.
 *
 * Third time tonight that two lists in different languages disagreed with
 * nothing comparing them. See also capture-scopes.test.ts.
 */
describe("the scopes the web app offers", () => {
  async function offered(): Promise<string[]> {
    const modal = await readFile(
      resolve(process.cwd(), "../web/src/views/settings/CreateKeyModal.tsx"),
      "utf8",
    );
    const block = /export const KEY_SCOPES[^=]*=\s*\[([\s\S]*?)\];/u.exec(modal);
    expect(block, "KEY_SCOPES should be a literal array; has it moved?").not.toBeNull();
    return [...block![1]!.matchAll(/scope: '([a-z:*-]+)'/gu)].map((match) => match[1]!);
  }

  it("are scopes this server knows", async () => {
    const scopes = await offered();
    expect(scopes.length, "no scopes parsed; has the shape changed?").toBeGreaterThan(1);
    const known = new Set<string>(KNOWN_SCOPES);
    expect(scopes.filter((scope) => !known.has(scope))).toEqual([]);
  });

  it("are scopes the person creating the key already holds", async () => {
    const held = new Set(PASSWORD_SCOPES);
    const ungrantable = (await offered()).filter((scope) => !held.has(scope));
    expect(ungrantable, "the server refuses a key that outranks its creator").toEqual([]);
  });

  it("never offers the power to mint another credential", async () => {
    const scopes = await offered();
    expect(scopes).not.toContain("keys:write");
    expect(scopes).not.toContain("*");
    // Machine credentials are minted by the agent, not chosen in a browser.
    for (const machineOnly of ["machine:heartbeat", "materialize:read", "ingest:write"]) {
      expect(scopes, `${machineOnly} belongs to a machine token`).not.toContain(machineOnly);
    }
  });
});
