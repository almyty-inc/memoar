import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertProductionCredentials, productionCredentialProblems } from "../src/startup-checks.js";

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

  it("leaves development alone", () => {
    // The same file has to keep working locally, or nobody can run the stack.
    expect(() => assertProductionCredentials({ ...exampleEnvironment(), NODE_ENV: "development" })).not.toThrow();
  });
});
