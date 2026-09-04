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
 * @returns every reason this configuration must not run in production.
 */
export function productionCredentialProblems(environment: NodeJS.ProcessEnv = process.env): StartupProblem[] {
  const problems: StartupProblem[] = [];
  for (const credential of credentials(environment)) {
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

/** Throws unless production is configured with credentials worth having. */
export function assertProductionCredentials(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.NODE_ENV !== "production") return;
  const problems = productionCredentialProblems(environment);
  if (problems.length === 0) return;
  throw new Error(
    `refusing to start: ${problems.map((problem) => `${problem.name} ${problem.reason}`).join("; ")}`,
  );
}
