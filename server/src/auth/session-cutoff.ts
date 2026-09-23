import type { EntityManager } from "typeorm";

import { UserEntity } from "../entities.js";

import type { DevAccount } from "./oauth-accounts.js";
import type { TokenClaims } from "./types.js";

/**
 * The line an account's browser sessions have to be on the right side of.
 *
 * Browser tokens are revoked one at a time by jti and nothing records them as
 * they are minted, so there was no way to end every session an account has.
 * This is that way: a moment before which sessions stop counting, and at most
 * one session that is kept across it (the one a password change was made
 * from). See the SessionCutoff migration.
 */
export interface SessionCutoff {
  /** Epoch milliseconds, or null when the account has never cut its sessions. */
  notBefore: number | null;
  keptJti: string | null;
}

/** Whether a token minted at `iat` still counts under this cutoff. */
export function survivesCutoff(claims: TokenClaims, cutoff: SessionCutoff): boolean {
  if (cutoff.notBefore === null) return true;
  if (cutoff.keptJti !== null && claims.jti === cutoff.keptJti) return true;
  // A token from before `iat` existed was minted before any cutoff this code
  // could have written, so it is on the wrong side of every one.
  return claims.iat !== undefined && claims.iat * 1000 >= cutoff.notBefore;
}

export function cutoffOf(user: Pick<UserEntity, "sessionsNotBefore" | "sessionsKeptJti">): SessionCutoff {
  return { notBefore: user.sessionsNotBefore?.getTime() ?? null, keptJti: user.sessionsKeptJti };
}

export function devCutoffOf(user: DevAccount): SessionCutoff {
  return { notBefore: user.sessionsNotBefore ?? null, keptJti: user.sessionsKeptJti ?? null };
}

/**
 * Ends every browser session of one account from now on, except `keptJti`.
 *
 * Pass null to keep none, which is what an operator reset does. Written in the
 * caller's transaction so a password and the sessions it ends change together.
 */
export async function cutSessions(manager: EntityManager, userId: string, keptJti: string | null): Promise<void> {
  await manager.getRepository(UserEntity).update({ id: userId }, { sessionsNotBefore: new Date(), sessionsKeptJti: keptJti });
}

/** The in-memory twin of `cutSessions`. */
export function cutDevSessions(user: DevAccount, keptJti: string | null): void {
  user.sessionsNotBefore = Date.now();
  if (keptJti === null) delete user.sessionsKeptJti;
  else user.sessionsKeptJti = keptJti;
}
