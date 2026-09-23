import { Injectable } from "@nestjs/common";

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import type { TokenClaims } from "./types.js";

function base64(value: string): string {
  return Buffer.from(value).toString("base64url");
}

@Injectable()
export class TokenService {
  private readonly signingKey: string;

  constructor() {
    const configured = process.env.MEMOAR_TOKEN_SECRET;
    const isDevelopment = process.env.NODE_ENV !== "production";
    if (!configured && !isDevelopment) throw new Error("MEMOAR_TOKEN_SECRET is required outside development/test");
    this.signingKey = configured ?? "memoar-dev-token-secret-do-not-use-in-production";
  }

  issue(claims: Omit<TokenClaims, "exp" | "jti" | "iat">, ttlSeconds: number): { token: string; expiresAt: string } {
    const now = Date.now();
    const payload: TokenClaims = {
      ...claims, jti: randomBytes(12).toString("base64url"), iat: now / 1000, exp: Math.floor(now / 1000) + ttlSeconds,
    };
    const encoded = `${base64(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64(JSON.stringify(payload))}`;
    const signature = createHmac("sha256", this.signingKey).update(encoded).digest("base64url");
    return { token: `${encoded}.${signature}`, expiresAt: new Date(payload.exp * 1000).toISOString() };
  }

  /**
   * A state parameter and the secret the browser must hand back beside it.
   *
   * Only the digest of the nonce goes into the state, so the value travelling
   * through the provider, the browser's address bar and everybody's logs is not
   * the value that proves the flow was started here. See oauth-state-cookie.ts
   * for what the second half is for.
   */
  issueOAuthState(provider: string): { state: string; nonce: string } {
    const nonce = randomBytes(32).toString("base64url");
    const payload = base64(JSON.stringify({
      provider,
      nonce: createHash("sha256").update(nonce).digest("base64url"),
      exp: Math.floor(Date.now() / 1000) + 600,
    }));
    const signature = createHmac("sha256", this.signingKey).update(payload).digest("base64url");
    return { state: `${payload}.${signature}`, nonce };
  }

  /**
   * Whether this callback ends a sign-in this browser began.
   *
   * The signature says the state came from here, which is no distinction at all
   * — `GET /auth/oauth/:provider` is public and hands one to anybody. The nonce
   * is what narrows "from this server" to "from this browser".
   */
  verifyOAuthState(state: string, provider: string, nonce: string | null): boolean {
    if (!nonce) return false;
    const [payload, signature] = state.split(".");
    if (!payload || !signature) return false;
    const expected = createHmac("sha256", this.signingKey).update(payload).digest();
    const received = Buffer.from(signature, "base64url");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return false;
    try {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { provider?: string; nonce?: string; exp?: number };
      if (decoded.provider !== provider) return false;
      if (typeof decoded.exp !== "number" || decoded.exp <= Math.floor(Date.now() / 1000)) return false;
      const bound = Buffer.from(String(decoded.nonce ?? ""));
      const presented = Buffer.from(createHash("sha256").update(nonce).digest("base64url"));
      return bound.length === presented.length && timingSafeEqual(bound, presented);
    } catch {
      return false;
    }
  }

  verify(token: string): TokenClaims | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    if (!header || !payload || !signature) return null;
    const expected = createHmac("sha256", this.signingKey).update(`${header}.${payload}`).digest();
    const received = Buffer.from(signature, "base64url");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
      return claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
    } catch {
      return null;
    }
  }
}

export function hashSecret(secret: string, salt = randomBytes(16).toString("hex")): string {
  const digest = scryptSync(secret, salt, 32).toString("hex");
  return `scrypt$${salt}$${digest}`;
}

export function verifySecret(secret: string, encoded: string): boolean {
  const [algorithm, salt, digest] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !digest) return false;
  const actual = scryptSync(secret, salt, 32);
  const expected = Buffer.from(digest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface DevApiKey {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  prefix: string;
  secretHash: string;
  scopes: string[];
  createdAt: string;
  revokedAt: string | null;
}
