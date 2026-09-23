import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { DataSource, In, IsNull } from "typeorm";

import { cutSessions } from "./auth/session-cutoff.js";
import { hashSecret } from "./auth/tokens.js";
import { dataSourceFor } from "./data-source.js";
import { ApiKeyEntity, AuthIdentityEntity, MachineTokenEntity, UserEntity } from "./entities.js";

/**
 * The way back into an account whose password is lost.
 *
 * There is no email sending in Memoar, so there is no self-service reset. This
 * is the operator's path instead: somebody with database access runs it, hands
 * the printed password to the account's owner, and the owner changes it in
 * Settings. See docs/password-reset.md.
 */
export class ResetRefused extends Error {}

export interface ResetOutcome {
  email: string;
  userId: string;
  /** Shown once by the CLI. Never stored anywhere but as a hash. */
  password: string;
  revoked: { apiKeys: number; machineTokens: number };
}

/**
 * Sets a new random password and ends everything the account is signed in with.
 *
 * Everything, not only browser sessions: whoever took the account over may
 * have minted an API key or enrolled a machine with it. Ended here are every
 * browser session, every API key (and so every MCP session exchanged for one)
 * and every machine token. OAuth sign-in is left alone because it is a way in
 * the owner controls at their provider, not a credential issued here.
 *
 * Refuses an address with no password identity rather than creating one. An
 * account that signs in only with a provider has no password to reset, and
 * minting one would add a way in that its owner never asked for.
 */
export async function resetPassword(dataSource: DataSource, rawEmail: string): Promise<ResetOutcome> {
  const email = rawEmail.trim().toLowerCase();
  // 24 characters of base64url: 144 bits, well past the length rule.
  const password = randomBytes(18).toString("base64url");
  return dataSource.transaction(async (manager) => {
    const identities = manager.getRepository(AuthIdentityEntity);
    const identity = await identities.findOne({
      where: { kind: "password", lookupKey: email, revokedAt: IsNull() },
      lock: { mode: "pessimistic_write" },
    });
    if (!identity) throw new ResetRefused(`No account with a password is registered to ${email}. Nothing was changed.`);
    const { userId } = identity;
    const secretHash = hashSecret(password);
    await identities.update({ id: identity.id }, { secretHash });
    await manager.getRepository(UserEntity).update({ id: userId }, { passwordHash: secretHash });
    await cutSessions(manager, userId, null);

    const credentials = await identities.find({ where: [
      { kind: "api_key", userId, revokedAt: IsNull() },
      { kind: "machine_token", userId, revokedAt: IsNull() },
    ] });
    const revokedAt = new Date();
    if (credentials.length > 0) await identities.update({ id: In(credentials.map((row) => row.id)) }, { revokedAt });
    // The identity rows are what every request re-checks. The api_keys and
    // machine_tokens rows mirror them for listing, and sit under row-level
    // security, so each is written inside its own tenant.
    for (const tenantId of new Set(credentials.map((row) => row.tenantId))) {
      await manager.query("SELECT set_config('memoar.tenant_id', $1, true)", [tenantId]);
      await manager.getRepository(ApiKeyEntity).update({ tenantId, userId, revokedAt: IsNull() }, { revokedAt });
      const tokenHashes = credentials.filter((row) => row.kind === "machine_token" && row.tenantId === tenantId).map((row) => row.lookupKey);
      if (tokenHashes.length > 0) await manager.getRepository(MachineTokenEntity).update({ tenantId, tokenHash: In(tokenHashes) }, { revokedAt });
    }
    return {
      email, userId, password,
      revoked: {
        apiKeys: credentials.filter((row) => row.kind === "api_key").length,
        machineTokens: credentials.filter((row) => row.kind === "machine_token").length,
      },
    };
  });
}

function argValue(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return typeof value === "string" && !value.startsWith("--") ? value : null;
}

export interface ResetIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** The CLI: `node dist/reset-password.js --email <email>`. Returns the exit code. */
export async function runResetPassword(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  io: ResetIo = { out: (line) => console.log(line), err: (line) => console.error(line) },
): Promise<number> {
  const email = argValue(argv, "email");
  if (!email) {
    io.err("usage: reset-password --email <email>");
    return 2;
  }
  if (!env.DATABASE_URL) {
    io.err("DATABASE_URL is not set. This resets an account in the database, so it needs one.");
    return 2;
  }
  const dataSource = dataSourceFor(env.DATABASE_URL);
  await dataSource.initialize();
  try {
    const outcome = await resetPassword(dataSource, email);
    io.out(`Password reset for ${outcome.email}.`);
    io.out(`New password, shown once and stored only as a hash: ${outcome.password}`);
    io.out(`Ended every browser session, ${outcome.revoked.apiKeys} API key(s) with the MCP sessions made from them, and ${outcome.revoked.machineTokens} machine token(s).`);
    io.out("Give the password to the owner over a channel you trust. They should change it in Settings, then sign the capture agent in again.");
    return 0;
  } catch (error) {
    if (!(error instanceof ResetRefused)) throw error;
    io.err(error.message);
    return 1;
  } finally {
    await dataSource.destroy();
  }
}
