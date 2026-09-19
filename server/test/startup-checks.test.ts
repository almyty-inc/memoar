import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hashSecret } from "../src/auth/tokens.js";
import { assertNoPublishedAccountPasswords, assertProductionCredentials, assertTenantIsolationEnforced, productionCredentialProblems } from "../src/startup-checks.js";

/** The example file the README tells you to copy. */
function exampleEnvironment(): NodeJS.ProcessEnv {
  const text = readFileSync(resolve(process.cwd(), "../.env.example"), "utf8");
  const environment: NodeJS.ProcessEnv = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
    if (match) environment[match[1]!] = match[2];
  }
  // After parsing: the file sets NODE_ENV=development itself, which is the
  // whole point of it, and setting production first would just be overwritten.
  return { ...environment, NODE_ENV: "production" };
}

const STRONG: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  MEMOAR_TOKEN_SECRET: "9f2c1d4e8a7b6c5d0e3f2a1b9c8d7e6f5a4b3c2d1e0f",
  MEMOAR_APP_DB_PASSWORD: "l0ng-enough-db-password",
  S3_SECRET_KEY: "another-long-object-store-key",
};

describe("what production refuses to start with", () => {
  it("rejects the credentials published in this repository", () => {
    // MEMOAR_TOKEN_SECRET signs every session token. It was required outside
    // development but any value passed, so a deployment that copied
    // .env.example wholesale — which the README tells you to do — let anyone
    // who has read the repository mint a token for any tenant.
    const problems = productionCredentialProblems(exampleEnvironment());
    const names = problems.map((problem) => problem.name);

    expect(names, "the example file must not be usable in production").toContain("MEMOAR_TOKEN_SECRET");
    expect(names).toContain("MEMOAR_APP_DB_PASSWORD");
    expect(names).toContain("S3_SECRET_KEY");
    expect(problems.every((problem) => problem.reason.includes("published"))).toBe(true);
  });

  it("rejects an unset or short secret", () => {
    expect(productionCredentialProblems({ ...STRONG, MEMOAR_TOKEN_SECRET: undefined })[0])
      .toEqual({ name: "MEMOAR_TOKEN_SECRET", reason: "is not set" });
    expect(productionCredentialProblems({ ...STRONG, MEMOAR_TOKEN_SECRET: "short" })[0]!.reason)
      .toContain("shorter than 32");
  });

  it("accepts credentials worth having", () => {
    expect(productionCredentialProblems(STRONG)).toEqual([]);
    expect(() => assertProductionCredentials(STRONG)).not.toThrow();
  });

  it("names every problem at once, rather than one per restart", () => {
    expect(() => assertProductionCredentials(exampleEnvironment()))
      .toThrow(/MEMOAR_TOKEN_SECRET.*MEMOAR_APP_DB_PASSWORD.*S3_SECRET_KEY/su);
  });

  it("refuses the credential key that ships in the compose file", () => {
    // Sixty-four hex characters look exactly like a key somebody generated,
    // which is what makes this one dangerous: it passes inspection by eye and
    // it is in the repository. Everything sealed with it — every tenant's
    // provider API key — is readable by anyone who has cloned this, and that
    // becomes anyone at all the day the repository is public.
    const published = "6b1f3c7d9a2e4f508192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8";
    expect(productionCredentialProblems({ ...STRONG, MEMOAR_CREDENTIAL_KEY: published })[0])
      .toEqual({ name: "MEMOAR_CREDENTIAL_KEY", reason: "is a value published in this repository" });

    // Short is refused too: a key that looks like encryption and is not is
    // worse than no key, because no key refuses to store the credential.
    expect(productionCredentialProblems({ ...STRONG, MEMOAR_CREDENTIAL_KEY: "too-short-to-be-a-key" })[0]!.reason)
      .toContain("shorter than 44");

    // Absent is fine — the deployment simply cannot hold provider credentials.
    expect(productionCredentialProblems(STRONG)).toEqual([]);
    expect(productionCredentialProblems({ ...STRONG, MEMOAR_CREDENTIAL_KEY: "b".repeat(64) })).toEqual([]);
  });

  it("refuses production with the development conveniences switched on", () => {
    // MEMOAR_DEV_AUTH accepts an X-Memoar-Tenant header naming any tenant on
    // earth. It is not a weak credential, it is the absence of one.
    const problems = productionCredentialProblems({ ...STRONG, MEMOAR_DEV_AUTH: "true" });
    expect(problems).toEqual([{ name: "MEMOAR_DEV_AUTH", reason: "is enabled, which lets any caller name their own tenant" }]);
    expect(() => assertProductionCredentials({ ...STRONG, MEMOAR_DEV_AUTH: "true" })).toThrow(/MEMOAR_DEV_AUTH/u);
  });

  it("rejects the first account's password when it is published or guessable", () => {
    const published = productionCredentialProblems({ ...STRONG, MEMOAR_BOOTSTRAP_PASSWORD: "memoar-demo-password" });
    expect(published[0]).toEqual({ name: "MEMOAR_BOOTSTRAP_PASSWORD", reason: "is a value published in this repository" });

    expect(productionCredentialProblems({ ...STRONG, MEMOAR_BOOTSTRAP_PASSWORD: "short-one" })[0]!.reason)
      .toContain("shorter than 12");

    // An archive with no first account configured is fine; that is the normal
    // state of one that already has its accounts.
    expect(productionCredentialProblems(STRONG)).toEqual([]);
    expect(productionCredentialProblems({ ...STRONG, MEMOAR_BOOTSTRAP_PASSWORD: "a-password-nobody-published" })).toEqual([]);
  });

  it("refuses production while an account seeded by an older build keeps its published password", async () => {
    // Removing the code that created demo@memoar.dev does not remove the
    // account from an archive that already ran it, and the password is in the
    // repository. This is the upgrade path, not the fresh install.
    const seeded = (email: string) =>
      Promise.resolve(email === "demo@memoar.dev" ? { secretHash: hashSecret("memoar-demo-password") } : null);

    await expect(assertNoPublishedAccountPasswords(seeded, { NODE_ENV: "production" }))
      .rejects.toThrow(/demo@memoar\.dev still uses a password published/u);

    // Once the password has been changed, the same account is fine.
    const changed = (email: string) =>
      Promise.resolve(email === "demo@memoar.dev" ? { secretHash: hashSecret("something-nobody-published") } : null);
    await expect(assertNoPublishedAccountPasswords(changed, { NODE_ENV: "production" })).resolves.toBeUndefined();

    // And an archive that never had the account is untouched.
    await expect(assertNoPublishedAccountPasswords(() => Promise.resolve(null), { NODE_ENV: "production" })).resolves.toBeUndefined();
  });

  it("refuses to serve on a database role that row-level security does not apply to", async () => {
    /*
      Every tenant policy in this schema is FORCE ROW LEVEL SECURITY, and
      Postgres applies none of it to a superuser or to a role holding BYPASSRLS.
      Nothing checked which role the process connected as, so setting
      DATABASE_URL to the bootstrap superuser — the URL every local tool prints,
      and the one MIGRATION_DATABASE_URL is for — turned every policy into a
      no-op with no symptom at all: one tenant's queries simply returned
      another's rows.
    */
    await expect(assertTenantIsolationEnforced(() =>
      Promise.resolve({ name: "postgres", superuser: true, bypassRls: false })))
      .rejects.toThrow(/"postgres" is a superuser/u);

    await expect(assertTenantIsolationEnforced(() =>
      Promise.resolve({ name: "memoar_rw", superuser: false, bypassRls: true })))
      .rejects.toThrow(/holds BYPASSRLS/u);

    // A role that cannot be identified is not a role that has been cleared.
    await expect(assertTenantIsolationEnforced(() => Promise.resolve(null)))
      .rejects.toThrow(/could not determine the database role/u);

    // The least-privilege role the AppRole migration creates.
    await expect(assertTenantIsolationEnforced(() =>
      Promise.resolve({ name: "memoar_app", superuser: false, bypassRls: false })))
      .resolves.toBeUndefined();
  });

  it("leaves development alone", () => {
    // The same file has to keep working locally, or nobody can run the stack.
    expect(() => assertProductionCredentials({ ...exampleEnvironment(), NODE_ENV: "development" })).not.toThrow();
  });
});
