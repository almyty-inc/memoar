import type { TenantContext } from "../archive-store.js";

/** Claims carried by every Memoar-issued bearer token. */
export interface TokenClaims {
  /** Unique per issuance, so two tokens minted in the same second differ. */
  jti: string;
  sub: string;
  tenantId: string;
  scopes: string[];
  /**
   * What minted it: a sign-in, a machine, or the MCP handshake.
   *
   * "mcp" exists so the handshake's tokens stop being recognised by the shape
   * of their scope list. They used to be minted as "browser" and identified by
   * carrying mcp:use and nothing else — a tell that would have quietly
   * misfiled every one of them the first time a handshake token was given a
   * second scope.
   */
  type: "browser" | "machine" | "mcp";
  exp: number;
  /**
   * When it was minted, in seconds with a fractional part (RFC 7519 allows
   * one). Whole seconds would not do: a password change ends every session
   * minted before it, and a sign-in in the same second after the change must
   * survive. Absent on tokens minted before this claim existed.
   */
  iat?: number;
  machineId?: string;
  /**
   * The credential this token was derived from, for a token that was derived
   * from one: the `auth_identities` row of the API key the handshake exchanged.
   * Revocation is checked against this row, so revoking that key kills this
   * token even while other keys on the account stay live.
   */
  credentialId?: string;
}

/** The subset of the Express request the guard and decorators read. */
export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  tenantContext?: TenantContext;
  route?: { path?: string };
  method?: string;
  url?: string;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
}
