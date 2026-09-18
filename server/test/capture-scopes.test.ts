import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PASSWORD_SCOPES } from "../src/bootstrap-account.js";
import { KNOWN_SCOPES } from "../src/auth/scopes.js";

/**
 * A key the agent asks for at sign-in must be one the person signing in can
 * grant.
 *
 * These two lists live in two languages and nothing compared them. The agent
 * asked for `materialize:read`; a password session does not hold it; and the
 * moment the server began refusing a key that outranks the session creating it
 * — a fix for a real escalation, where any user could mint `["*"]` — every
 * `memoar login` started failing with a 403. Both changes were right on their
 * own and neither test could see the other half.
 *
 * Caught by the Compose end-to-end run in under a second, which is the argument
 * for having one. This is the cheaper place to catch it again.
 */
describe("the scopes the capture agent asks for", () => {
  it("are ones a password session can grant", async () => {
    const credential = await readFile(
      resolve(process.cwd(), "../agent/crates/memoar-cli/src/credential.rs"),
      "utf8",
    );
    const block = /const CAPTURE_SCOPES: \[&str; \d+\] = \[([^\]]*)\]/u.exec(credential);
    expect(block, "CAPTURE_SCOPES should be a literal array; has it moved?").not.toBeNull();
    const requested = [...block![1]!.matchAll(/"([a-z:*-]+)"/gu)].map((match) => match[1]!);
    expect(requested.length, "no scopes were parsed; has the shape changed?").toBeGreaterThan(2);

    const held = new Set(PASSWORD_SCOPES);
    const ungrantable = requested.filter((scope) => !held.has(scope));
    expect(ungrantable, "login mints a key with these, and the server will refuse them").toEqual([]);
  });

  it("are scopes this server knows", async () => {
    const credential = await readFile(
      resolve(process.cwd(), "../agent/crates/memoar-cli/src/credential.rs"),
      "utf8",
    );
    const block = /const CAPTURE_SCOPES: \[&str; \d+\] = \[([^\]]*)\]/u.exec(credential);
    const requested = [...block![1]!.matchAll(/"([a-z:*-]+)"/gu)].map((match) => match[1]!);
    const known = new Set<string>(KNOWN_SCOPES);
    expect(requested.filter((scope) => !known.has(scope))).toEqual([]);
    // And never the wildcard, which the guard honours as every scope.
    expect(requested).not.toContain("*");
  });
});
