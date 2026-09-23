import { DataSource, IsNull } from "typeorm";

import { developmentAuthEnabled } from "../dev-mode.js";
import { AuthIdentityEntity, UserEntity } from "../entities.js";

import type { BrowserSessionService } from "./browser-sessions.js";
import type { CredentialsService } from "./credentials.service.js";
import type { DevAccount } from "./oauth-accounts.js";
import { cutoffOf, devCutoffOf, survivesCutoff } from "./session-cutoff.js";
import type { TokenClaims } from "./types.js";

/**
 * The scopes the MCP handshake minted, back when the scope list was the only
 * record of where a token had come from.
 *
 * Kept for the tokens already in flight on a deploy of this change: they were
 * minted as `type: "browser"` carrying mcp:use and nothing else, and are still
 * recognised that way until the last of them expires — within the hour, since
 * that is all the handshake ever grants. New tokens say what they are.
 */
const LEGACY_MCP_SESSION_SCOPES = ["mcp:use"];

export interface TokenLivenessLookups {
  sessions: BrowserSessionService;
  credentials: CredentialsService;
  dataSource: DataSource | null;
  /** The accounts held in memory when there is no database to hold them. */
  devUsers: Iterable<DevAccount>;
}

/**
 * Whether a session token still stands for something.
 *
 * A browser token used to be trusted on its signature alone: this check did not
 * exist and `authenticateBearer` returned before any lookup, so a machine token
 * was re-checked against `auth_identities` on every request while a browser
 * token — the credential a person actually holds — was checked on none.
 * Deleting the account, revoking its identity or signing out changed nothing
 * for the full hour the token had left.
 *
 * The credential behind the token decides. An MCP token lives as long as the
 * one API key it was exchanged for; anything else is a sign-in, and lives as
 * long as the sign-in identity does.
 */
export async function sessionTokenLive(claims: TokenClaims, lookups: TokenLivenessLookups): Promise<boolean> {
  if (await lookups.sessions.isRevoked(claims)) return false;
  if (claims.type === "mcp") return mcpTokenLive(claims, lookups);
  if (mintedByLegacyHandshake(claims)) return lookups.credentials.hasLiveApiKey(claims.tenantId, claims.sub);
  return signInIdentityLive(claims, lookups);
}

/**
 * An MCP token lives exactly as long as the key it was minted from.
 *
 * This used to ask whether the account held *any* unrevoked key, because the
 * token recorded nothing about which one had produced it. An account with two
 * keys could revoke the one a token came from and watch that token keep reading
 * whole sessions — `get_session` and `search_sessions` both do — until every
 * other key on the account had been revoked too.
 *
 * A token with no credential named on it can only have come from development
 * auth, which has no key to exchange, so it is worth exactly what development
 * auth is worth: everything on a machine that asked for it by name, and nothing
 * anywhere else.
 */
function mcpTokenLive(claims: TokenClaims, lookups: TokenLivenessLookups): Promise<boolean> | boolean {
  if (!claims.credentialId) return developmentAuthEnabled();
  return lookups.credentials.apiKeyCredentialLive(claims.tenantId, claims.sub, claims.credentialId);
}

/** A token minted before the handshake said so in the token itself. */
function mintedByLegacyHandshake(claims: TokenClaims): boolean {
  return claims.scopes.length === LEGACY_MCP_SESSION_SCOPES.length
    && LEGACY_MCP_SESSION_SCOPES.every((scope) => claims.scopes.includes(scope));
}

/**
 * A sign-in lives as long as its identity does, and only while it was minted
 * after the account last cut its sessions (a password change or an operator
 * reset: see session-cutoff.ts).
 */
async function signInIdentityLive(claims: TokenClaims, lookups: TokenLivenessLookups): Promise<boolean> {
  if (!lookups.dataSource) {
    const user = [...lookups.devUsers].find((candidate) => candidate.id === claims.sub && candidate.tenantId === claims.tenantId);
    return user !== undefined && survivesCutoff(claims, devCutoffOf(user));
  }
  const identityLive = await lookups.dataSource.getRepository(AuthIdentityEntity).existsBy(
    // The tenant is re-read from the identity, not taken from the token: a
    // signed token naming another tenant must still resolve to nothing.
    (["password", "oauth"] as const).map((kind) => ({
      kind, tenantId: claims.tenantId, userId: claims.sub, revokedAt: IsNull(),
    })),
  );
  if (!identityLive) return false;
  const user = await lookups.dataSource.getRepository(UserEntity).findOne({
    where: { id: claims.sub }, select: { id: true, sessionsNotBefore: true, sessionsKeptJti: true },
  });
  return user === null || survivesCutoff(claims, cutoffOf(user));
}
