/**
 * The one account a fresh archive can be created with.
 *
 * An empty archive has nobody in it, so there has to be some way to make the
 * first account. What used to be here was a `demo@memoar.dev` user whose
 * password — `memoar-demo-password` — was written in the source, created
 * whenever `MEMOAR_SEED_DEMO` was set. A published password on a real archive
 * is a back door, so both halves are gone: the credentials come from the
 * environment, and there is no default for either.
 *
 * The identifiers are derived from the address rather than fixed, so running
 * the server twice over the same database converges on one account instead of
 * a second one.
 */

import { uuidV5 } from "./ids.js";

export interface BootstrapAccount {
  userId: string;
  tenantId: string;
  identityId: string;
  email: string;
  password: string;
  displayName: string;
}

/** Everything an account needs, or null when none was asked for. */
export function bootstrapAccount(environment: NodeJS.ProcessEnv = process.env): BootstrapAccount | null {
  const email = environment.MEMOAR_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = environment.MEMOAR_BOOTSTRAP_PASSWORD;
  if (!email || !password) return null;
  const tenantId = uuidV5(`bootstrap:tenant:${email}`);
  return {
    userId: uuidV5(`bootstrap:user:${email}`),
    tenantId,
    identityId: uuidV5(`bootstrap:identity:${email}`),
    email,
    password,
    displayName: environment.MEMOAR_BOOTSTRAP_NAME?.trim() || email,
  };
}

/** The scopes a person signing in with a password holds. */
export const PASSWORD_SCOPES = [
  "archive:read", "archive:write", "sharing:write",
  "keys:write", "machines:write", "ingest:write", "mcp:use",
];
