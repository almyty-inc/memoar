/**
 * The single switch for every convenience that must never be reachable in a
 * real deployment.
 *
 * These conveniences — a fixed bearer token, tenant headers that name whatever
 * tenant they like, an in-memory account — used to be enabled by the *absence*
 * of `NODE_ENV=production`. That fails open: an operator who runs the built
 * server without setting that one variable gets an API where anybody can send
 *
 *     X-Memoar-Tenant: <someone's tenant>
 *     X-Memoar-User: <anybody>
 *
 * and receive full scopes on that tenant's archive. Forgetting to set a
 * variable is not a decision, and it should not be what stands between an
 * archive and the internet.
 *
 * So the gate is inverted: development authentication is off unless it has
 * been asked for by name, and asking for it in production refuses the boot
 * (see startup-checks.ts).
 */

/** True only when this process has explicitly opted into development auth. */
export function developmentAuthEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.MEMOAR_DEV_AUTH === "true";
}
