import type { TenantContext } from "../archive-store.js";

/** Claims carried by every Memoar-issued bearer token. */
export interface TokenClaims {
  /** Unique per issuance, so two tokens minted in the same second differ. */
  jti: string;
  sub: string;
  tenantId: string;
  scopes: string[];
  type: "browser" | "machine";
  exp: number;
  machineId?: string;
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
