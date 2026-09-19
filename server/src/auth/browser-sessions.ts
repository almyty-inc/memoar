import { Inject, Injectable } from "@nestjs/common";
import { DataSource, LessThan } from "typeorm";

import { AuthSessionEntity } from "../entities.js";
import { uuidV7 } from "../ids.js";
import type { TokenClaims } from "./types.js";

/**
 * The tokens a browser session has been signed out of.
 *
 * A browser token was trusted on its signature alone: `authenticateBearer`
 * returned before any lookup, so there was no sign-out at all — a token
 * captured from a laptop kept working for its full hour and nothing an
 * operator or the user could do would stop it. A machine token, by contrast,
 * has always been re-checked against `auth_identities` on every request.
 *
 * Kept as a deny-list rather than an allow-list of live sessions, because a
 * token's own `exp` already bounds how long an entry has to survive: a row is
 * needed only between a sign-out and the moment the token would have expired
 * anyway, so the table stays small and nothing has to be written on the
 * issuing path (which is also the path the MCP handshake mints on, outside
 * this module's reach).
 */
@Injectable()
export class BrowserSessionService {
  /** Used when there is no database: development, and the test suite. */
  private readonly revokedInMemory = new Map<string, number>();

  constructor(@Inject(DataSource) private readonly dataSource: DataSource | null) {}

  /** Signs one token out. Idempotent: signing out twice is not an error. */
  async revoke(claims: TokenClaims): Promise<void> {
    const expiresAt = new Date(claims.exp * 1000);
    if (!this.dataSource) {
      this.revokedInMemory.set(claims.jti, claims.exp);
      this.forgetExpired();
      return;
    }
    const repository = this.dataSource.getRepository(AuthSessionEntity);
    // The jti, not the token: a sign-out must not put anything back in the
    // database that could be replayed as a credential if the table leaked.
    if (await repository.existsBy({ tokenHash: claims.jti })) return;
    await repository.insert({
      id: uuidV7(), userId: claims.sub, tokenHash: claims.jti,
      expiresAt, revokedAt: new Date(),
    });
    // Rows are only useful until the token they name would have expired.
    await repository.delete({ expiresAt: LessThan(new Date()) });
  }

  async isRevoked(claims: TokenClaims): Promise<boolean> {
    if (!this.dataSource) {
      this.forgetExpired();
      return this.revokedInMemory.has(claims.jti);
    }
    const row = await this.dataSource.getRepository(AuthSessionEntity).findOneBy({ tokenHash: claims.jti });
    return row !== null && row.revokedAt !== null;
  }

  private forgetExpired(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, exp] of this.revokedInMemory) {
      if (exp <= now) this.revokedInMemory.delete(jti);
    }
  }
}
