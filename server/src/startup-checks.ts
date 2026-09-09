/**
 * Refuses to start in production on a credential anyone can read.
 *
 * `MEMOAR_TOKEN_SECRET` was required outside development but any value passed,
 * including the one in `.env.example` — which the README tells you to copy, and
 * which is in the repository. That value signs every session token, so a
 * deployment that took the example wholesale would let anyone who has read the
 * repository mint a token for any tenant. The same goes for the database role
 * password and the object-store keys.
 *
 * Checked at startup rather than at first use: a service that boots and then
 * fails on somebody's request has already told the world it is up.
 */

import { verifySecret } from "./auth/tokens.js";
import { developmentAuthEnabled } from "./dev-mode.js";

/** Values that ship in this repository and therefore protect nothing. */
const PUBLISHED_DEFAULTS = new Set([
  "local-development-only-change-me",
  "memoar_app",
  "memoar-local",
  "memoar-local-secret",
  "memoar",
  "memoar-demo-password",
  "memoar-dev-token-secret-do-not-use-in-production",
  "change-me",
  "changeme",
  "secret",
  "password",
  // The local stack's credential key. Sixty-four hex characters look exactly
  // like a key somebody generated, which is what makes this one dangerous: it
  // passes every length and entropy check by eye, and it is in the repository.
  // Anything encrypted with it — every tenant's provider API key — is readable
  // by anyone who has cloned this.
  "6b1f3c7d9a2e4f508192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8",
]);

interface Credential {
  name: string;
  value: string | undefined;
  /** Minimum length for a value that is meant to be unguessable. */
  minimumLength: number;
}

export interface StartupProblem {
  name: string;
  reason: string;
}

/** Every credential the API needs, and how weak it is allowed to be. */
function credentials(environment: NodeJS.ProcessEnv): Credential[] {
  return [
    { name: "MEMOAR_TOKEN_SECRET", value: environment.MEMOAR_TOKEN_SECRET, minimumLength: 32 },
    { name: "MEMOAR_APP_DB_PASSWORD", value: environment.MEMOAR_APP_DB_PASSWORD, minimumLength: 16 },
    { name: "S3_SECRET_KEY", value: environment.S3_SECRET_KEY, minimumLength: 16 },
  ];
}

/**
 * The credential key, which is optional and checked only when it is present.
 *
 * Unlike the three above, a deployment can legitimately run without one: it
 * simply refuses to store provider credentials. But a weak or published one is
 * worse than none, because it looks like encryption and is not — 44 characters
 * is base64 of 32 bytes, the shortest honest form of a key this takes.
 */
function optionalCredentials(environment: NodeJS.ProcessEnv): Credential[] {
  return environment.MEMOAR_CREDENTIAL_KEY
    ? [{ name: "MEMOAR_CREDENTIAL_KEY", value: environment.MEMOAR_CREDENTIAL_KEY, minimumLength: 44 }]
    : [];
}

/**
 * @returns every reason this configuration must not run in production.
 */
export function productionCredentialProblems(environment: NodeJS.ProcessEnv = process.env): StartupProblem[] {
  const problems: StartupProblem[] = [];

  // The development conveniences accept a header naming any tenant at all.
  // Enabling them here is not a weak credential, it is no credential.
  if (developmentAuthEnabled(environment)) {
    problems.push({
      name: "MEMOAR_DEV_AUTH",
      reason: "is enabled, which lets any caller name their own tenant",
    });
  }

  // The first account's password is a real credential the moment it exists.
  const bootstrapPassword = environment.MEMOAR_BOOTSTRAP_PASSWORD?.trim();
  if (bootstrapPassword) {
    if (PUBLISHED_DEFAULTS.has(bootstrapPassword.toLowerCase())) {
      problems.push({ name: "MEMOAR_BOOTSTRAP_PASSWORD", reason: "is a value published in this repository" });
    } else if (bootstrapPassword.length < 12) {
      problems.push({ name: "MEMOAR_BOOTSTRAP_PASSWORD", reason: "is shorter than 12 characters" });
    }
  }

  for (const credential of [...credentials(environment), ...optionalCredentials(environment)]) {
    const value = credential.value?.trim();
    if (!value) {
      problems.push({ name: credential.name, reason: "is not set" });
      continue;
    }
    if (PUBLISHED_DEFAULTS.has(value.toLowerCase())) {
      problems.push({ name: credential.name, reason: "is a value published in this repository" });
      continue;
    }
    if (value.length < credential.minimumLength) {
      problems.push({ name: credential.name, reason: `is shorter than ${credential.minimumLength} characters` });
    }
  }
  return problems;
}

/**
 * Accounts this repository's code used to create on its own, with a password
 * printed in the source. Deleting that code does not delete the accounts it
 * already made: an archive upgraded from an earlier build still has them, and
 * they still let anyone who has read the repository sign in.
 */
const SEEDED_ACCOUNTS: { email: string; password: string }[] = [
  { email: "demo@memoar.dev", password: "memoar-demo-password" },
];

/**
 * Refuses production while an account seeded by an older build still has the
 * password that was published with it.
 *
 * Only the addresses this code ever created are checked, and only against the
 * password it gave them — one lookup and one hash each, rather than trying
 * every account in the archive against a word list at every boot.
 */
export async function assertNoPublishedAccountPasswords(
  findIdentity: (email: string) => Promise<{ secretHash: string } | null>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (environment.NODE_ENV !== "production") return;
  const exposed: string[] = [];
  for (const account of SEEDED_ACCOUNTS) {
    const identity = await findIdentity(account.email);
    if (identity && verifySecret(account.password, identity.secretHash)) exposed.push(account.email);
  }
  if (exposed.length === 0) return;
  throw new Error(
    `refusing to start: ${exposed.join(", ")} still uses a password published in this repository. ` +
    "Change the password or remove the account before serving this archive.",
  );
}

/** Throws unless production is configured with credentials worth having. */
export function assertProductionCredentials(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.NODE_ENV !== "production") return;
  const problems = productionCredentialProblems(environment);
  if (problems.length === 0) return;
  throw new Error(
    `refusing to start: ${problems.map((problem) => `${problem.name} ${problem.reason}`).join("; ")}`,
  );
}
