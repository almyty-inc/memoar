import { hashSecret } from "./tokens.js";
import { randomBytes } from "node:crypto";
import { DataSource, IsNull } from "typeorm";

import { PASSWORD_SCOPES, registrationClosed, signupOpen } from "../bootstrap-account.js";
import { AuthIdentityEntity, UserEntity } from "../entities.js";
import { uuidV7 } from "../ids.js";
import type { OAuthProfile } from "./oauth-provider.js";

/** An account held in memory, for a server running without a database. */
export interface DevAccount {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  displayName: string;
}

/** A hash no secret can ever match, for an account that signs in another way. */
function unusablePasswordHash(): string {
  return hashSecret(randomBytes(32).toString("hex"));
}

/**
 * The account behind a verified provider address, creating one only if this
 * archive is open to new accounts.
 *
 * Three things this replaces, each of which produced an account the operator
 * had not agreed to or an archive its owner could not find:
 *
 * The signup gate is consulted. A closed archive that merely had GITHUB_CLIENT_ID
 * set used to let anyone with a GitHub account in, fully scoped, while
 * /auth/register refused the same person.
 *
 * The tenant comes from the identity rather than from the user id, so somebody
 * who signs in with a password one day and a provider the next stays in one
 * tenant instead of being shown a second, empty archive.
 *
 * And an identity row is written, so `findAccountByEmail` — which is how a
 * colleague is added to a team — can resolve somebody who has only ever signed
 * in with a provider. Previously nothing was written at all and they were
 * invisible to every lookup by address.
 */
export async function resolveOAuthAccount(
  dataSource: DataSource | null,
  devAccounts: Map<string, DevAccount>,
  profile: OAuthProfile,
): Promise<{ id: string; tenantId: string }> {
  const { email, displayName } = profile;
  if (!dataSource) {
    const existing = devAccounts.get(email);
    if (existing) return { id: existing.id, tenantId: existing.tenantId };
    if (!signupOpen()) throw registrationClosed();
    const id = uuidV7();
    const tenantId = uuidV7();
    devAccounts.set(email, { id, tenantId, email, displayName, passwordHash: unusablePasswordHash() });
    return { id, tenantId };
  }

  const identities = dataSource.getRepository(AuthIdentityEntity);
  // One address is one person: whichever way they first arrived, they land in
  // the tenant their archive is already in rather than beside it.
  const existing = await identities.findOne({ where: [
    { kind: "oauth", lookupKey: email, revokedAt: IsNull() },
    { kind: "password", lookupKey: email, revokedAt: IsNull() },
  ] });
  if (existing) return { id: existing.userId, tenantId: existing.tenantId };
  if (!signupOpen()) throw registrationClosed();

  const tenantId = uuidV7();
  return dataSource.transaction(async (manager) => {
    const users = manager.getRepository(UserEntity);
    const row = await users.findOneBy({ email });
    const id = row?.id ?? uuidV7();
    if (!row) await users.insert({ id, email, displayName, passwordHash: null });
    await manager.getRepository(AuthIdentityEntity).insert({
      id: uuidV7(), kind: "oauth", lookupKey: email, tenantId, userId: id,
      // Never a usable secret: this identity carries the tenant and makes the
      // account findable by address. It must not become a second way in.
      secretHash: unusablePasswordHash(),
      scopes: PASSWORD_SCOPES, machineId: null, expiresAt: null, revokedAt: null, lastUsedAt: null,
    });
    return { id, tenantId };
  });
}
