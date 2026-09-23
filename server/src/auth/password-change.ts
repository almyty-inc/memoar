import { ConflictException, ForbiddenException } from "@nestjs/common";
import { DataSource, IsNull } from "typeorm";

import type { TenantContext } from "../archive-store.js";
import { AuthIdentityEntity, UserEntity } from "../entities.js";

import type { DevAccount } from "./oauth-accounts.js";
import { cutDevSessions, cutSessions } from "./session-cutoff.js";
import { hashSecret, verifySecret } from "./tokens.js";
import type { TokenClaims } from "./types.js";

/** Where accounts live: the database, or memory when there is none. */
export interface AccountStore {
  dataSource: DataSource | null;
  devUsers: Map<string, DevAccount>;
}

/**
 * 403 rather than 401. The web client reads 401 as "you are signed out" and
 * drops the session, so a mistyped current password would have signed the
 * person out of the page they typed it into.
 */
function wrongPassword(): ForbiddenException {
  return new ForbiddenException({
    type: "https://memoar.dev/problems/wrong-password",
    title: "The current password is not correct",
    status: 403,
    code: "wrong_password",
  });
}

function noPassword(): ConflictException {
  return new ConflictException({
    type: "https://memoar.dev/problems/no-password",
    title: "This account signs in with a provider and has no password to change",
    status: 409,
    code: "no_password",
  });
}

/**
 * A change is made from a signed-in browser. That is the session it keeps
 * alive. An API key has no session to keep, and a key that leaked must not be
 * a way to lock the owner out of their own account.
 */
function browserOnly(): ForbiddenException {
  return new ForbiddenException({
    type: "https://memoar.dev/problems/browser-session-required",
    title: "A password is changed from a signed-in browser",
    status: 403,
    code: "browser_session_required",
  });
}

/** Whether this account has a password identity, so there is a password to change. */
export async function hasPasswordIdentity(store: AccountStore, context: TenantContext): Promise<boolean> {
  if (!store.dataSource) {
    const user = [...store.devUsers.values()].find((candidate) => candidate.id === context.userId);
    return user !== undefined && !user.passwordless;
  }
  return store.dataSource.getRepository(AuthIdentityEntity).existsBy({
    kind: "password", userId: context.userId, tenantId: context.tenantId, revokedAt: IsNull(),
  });
}

/**
 * Replaces the password and ends every other browser session of the account.
 *
 * Whoever had the old password may be signed in somewhere, and a change that
 * left them there would change nothing for the case it is usually made for.
 * The caller's own session is kept. API keys and machine tokens are not
 * touched: they were issued deliberately, are listed in Settings and are
 * revoked there. The operator reset (reset-password.ts) ends those too.
 */
export async function changeAccountPassword(
  store: AccountStore,
  context: TenantContext,
  claims: TokenClaims | null,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (context.authType !== "browser" || !claims || claims.type !== "browser" || claims.sub !== context.userId) throw browserOnly();

  if (!store.dataSource) {
    const user = [...store.devUsers.values()].find((candidate) => candidate.id === context.userId && candidate.tenantId === context.tenantId);
    if (!user || user.passwordless) throw noPassword();
    if (!verifySecret(currentPassword, user.passwordHash)) throw wrongPassword();
    user.passwordHash = hashSecret(newPassword);
    cutDevSessions(user, claims.jti);
    return;
  }

  await store.dataSource.transaction(async (manager) => {
    const identities = manager.getRepository(AuthIdentityEntity);
    // Locked, so two changes racing each other cannot both verify against the
    // same old hash and leave whichever wrote last in force unverified.
    const identity = await identities.findOne({
      where: { kind: "password", userId: context.userId, tenantId: context.tenantId, revokedAt: IsNull() },
      lock: { mode: "pessimistic_write" },
    });
    if (!identity) throw noPassword();
    if (!verifySecret(currentPassword, identity.secretHash)) throw wrongPassword();
    const secretHash = hashSecret(newPassword);
    await identities.update({ id: identity.id }, { secretHash });
    await manager.getRepository(UserEntity).update({ id: context.userId }, { passwordHash: secretHash });
    await cutSessions(manager, context.userId, claims.jti);
  });
}
