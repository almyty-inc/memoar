import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { DataSource, IsNull, type EntityManager } from "typeorm";

import type { ArchiveStore, TenantContext } from "../archive-store.js";
import { ApiKeyEntity, AuthIdentityEntity, MachineTokenEntity } from "../entities.js";
import { uuidV7 } from "../ids.js";
import { ARCHIVE_STORE } from "../tokens.js";
import { assertGrantableScopes } from "./scopes.js";
import { hashSecret, TokenService, verifySecret, type DevApiKey } from "./tokens.js";
import type { TokenClaims } from "./types.js";

/** What a machine credential may do, wherever one is minted or re-checked. */
export const MACHINE_SCOPES = ["ingest:write", "machine:heartbeat", "materialize:read"];

/**
 * How long a machine token lives.
 *
 * This is not a free choice. The bearer is validated once the request body has
 * arrived, so a token has to survive the whole upload, not just its start. The
 * agent allows an upload 30 minutes — the artifact ceiling is 256 MiB and that
 * is how long 256 MiB honestly takes on a domestic uplink — and it refuses to
 * begin a request on a token with less life than that left.
 *
 * At 900 seconds no token could ever satisfy that, so every large upload sent
 * all its bytes and was refused at the very end with `401`, and the agent would
 * have re-minted on every single request trying to find a token that qualified.
 * The lifetime has to exceed the upload window with room to be reused, which is
 * what an hour gives it. `machine token lifetime covers the upload window`
 * holds this to the agent's own constant, because these two numbers have twice
 * now drifted into disagreeing about how long an upload may take.
 *
 * Machine tokens are stored hashed and revocable, so the cost of the longer
 * life is bounded; the cost of the shorter one was that large uploads did not
 * work at all.
 */
export const MACHINE_TOKEN_TTL_SECONDS = 3600;

/**
 * The credentials a program holds: API keys, and the short-lived machine tokens
 * the capture agent runs on. Split from AuthService, which is about people
 * signing in, so neither file has to be read to understand the other.
 */
@Injectable()
export class CredentialsService {
  private readonly devApiKeys = new Map<string, DevApiKey>();
  /** Live machine token hashes without a database, and whose machine each is. */
  private readonly devMachineTokens = new Map<string, { tenantId: string; machineId: string }>();

  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(DataSource) private readonly dataSource: DataSource | null,
    @Inject(ARCHIVE_STORE) private readonly store: ArchiveStore,
  ) {}

  private async inTenant<T>(context: TenantContext, operation: (manager: EntityManager) => Promise<T>): Promise<T> {
    if (!this.dataSource) throw new Error("postgres_not_configured");
    return this.dataSource.transaction(async (manager) => {
      await manager.query("SELECT set_config('memoar.tenant_id', $1, true)", [context.tenantId]);
      return operation(manager);
    });
  }

  async createApiKey(context: TenantContext, name: string, scopes: string[]): Promise<{ apiKey: Record<string, unknown>; secret: string }> {
    // Before anything is minted: the vocabulary, and the caller's own grant.
    assertGrantableScopes(scopes, context.scopes);
    const secret = `memoar_${randomBytes(32).toString("base64url")}`;
    const prefix = secret.slice(0, 15);
    const id = uuidV7();
    const createdAt = new Date().toISOString();
    const secretHash = hashSecret(secret);
    if (this.dataSource) {
      await this.inTenant(context, async (manager) => {
        await manager.getRepository(ApiKeyEntity).save({
          id, tenantId: context.tenantId, userId: context.userId, name, prefix, secretHash, scopes,
          createdAt: new Date(createdAt), lastUsedAt: null, revokedAt: null,
        });
        await manager.getRepository(AuthIdentityEntity).save({
          id: uuidV7(), kind: "api_key", lookupKey: prefix, tenantId: context.tenantId, userId: context.userId,
          secretHash, scopes, machineId: null, expiresAt: null, revokedAt: null, lastUsedAt: null,
        });
      });
    } else this.devApiKeys.set(prefix, {
      id, tenantId: context.tenantId, userId: context.userId, name, prefix,
      secretHash, scopes, createdAt, revokedAt: null,
    });
    return { apiKey: { id, name, prefix, scopes, createdAt, lastUsedAt: null }, secret };
  }

  async listApiKeys(context: TenantContext): Promise<{ items: Record<string, unknown>[] }> {
    if (this.dataSource) {
      const rows = await this.inTenant(context, (manager) => manager.getRepository(ApiKeyEntity).findBy({ tenantId: context.tenantId }));
      return { items: rows.map((row) => ({
        id: row.id, name: row.name, prefix: row.prefix, scopes: row.scopes,
        createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      })) };
    }
    return { items: [...this.devApiKeys.values()].filter((key) => key.tenantId === context.tenantId).map((key) => ({
      id: key.id, name: key.name, prefix: key.prefix, scopes: key.scopes, createdAt: key.createdAt, lastUsedAt: null,
    })) };
  }

  async revokeApiKey(context: TenantContext, keyId: string): Promise<boolean> {
    if (this.dataSource) {
      return this.inTenant(context, async (manager) => {
        const row = await manager.getRepository(ApiKeyEntity).findOneBy({ id: keyId, tenantId: context.tenantId });
        if (!row) return false;
        const revokedAt = new Date();
        await manager.getRepository(ApiKeyEntity).update({ id: keyId, tenantId: context.tenantId }, { revokedAt });
        await manager.getRepository(AuthIdentityEntity).update({ kind: "api_key", lookupKey: row.prefix, tenantId: context.tenantId }, { revokedAt });
        return true;
      });
    }
    const key = [...this.devApiKeys.values()].find((candidate) => candidate.id === keyId && candidate.tenantId === context.tenantId);
    if (!key) return false;
    key.revokedAt = new Date().toISOString();
    return true;
  }

  /**
   * Whether this account still holds an API key that has not been revoked.
   *
   * Asked only of the tokens the MCP handshake minted before it recorded which
   * key it had exchanged (see `apiKeyCredentialLive`). It answers per account,
   * which is why an account with two keys could revoke one and keep reading
   * with the token that key had produced.
   */
  async hasLiveApiKey(tenantId: string, userId: string): Promise<boolean> {
    if (this.dataSource) {
      return this.dataSource.getRepository(AuthIdentityEntity).existsBy({ kind: "api_key", tenantId, userId, revokedAt: IsNull() });
    }
    return [...this.devApiKeys.values()].some((key) => !key.revokedAt && key.tenantId === tenantId && key.userId === userId);
  }

  /**
   * Whether one named API key is still live, for the account that claims it.
   *
   * The tenant and user are matched rather than read from the token alone, so
   * a signed token naming a credential from another archive resolves to
   * nothing however well it is formed.
   */
  async apiKeyCredentialLive(tenantId: string, userId: string, credentialId: string): Promise<boolean> {
    if (this.dataSource) {
      return this.dataSource.getRepository(AuthIdentityEntity).existsBy({
        id: credentialId, kind: "api_key", tenantId, userId, revokedAt: IsNull(),
      });
    }
    return [...this.devApiKeys.values()].some(
      (key) => key.id === credentialId && !key.revokedAt && key.tenantId === tenantId && key.userId === userId,
    );
  }

  async issueMachineToken(context: TenantContext, machineId: string): Promise<{ token: string; expiresAt: string }> {
    const machine = await this.store.getMachine(context, machineId);
    if (!machine) throw new UnauthorizedException("Machine is outside the active tenant");
    machine.lastSeenAt = new Date().toISOString();
    await this.store.saveMachine(context, machine);
    const issued = this.tokens.issue({
      sub: context.userId, tenantId: context.tenantId, scopes: MACHINE_SCOPES, type: "machine", machineId,
    }, MACHINE_TOKEN_TTL_SECONDS);
    const tokenHash = createHash("sha256").update(issued.token).digest("hex");
    if (this.dataSource) await this.inTenant(context, async (manager) => {
      await manager.getRepository(MachineTokenEntity).save({
        id: uuidV7(), tenantId: context.tenantId, machineId, tokenHash,
        expiresAt: new Date(issued.expiresAt), revokedAt: null,
      });
      await manager.getRepository(AuthIdentityEntity).save({
        id: uuidV7(), kind: "machine_token", lookupKey: tokenHash, tenantId: context.tenantId, userId: context.userId,
        secretHash: tokenHash, scopes: MACHINE_SCOPES, machineId,
        expiresAt: new Date(issued.expiresAt), revokedAt: null, lastUsedAt: null,
      });
    });
    else this.devMachineTokens.set(tokenHash, { tenantId: context.tenantId, machineId });
    return issued;
  }

  /**
   * Revokes every live token minted for one machine, and says how many.
   *
   * Both records are written. `auth_identities` is what `machineTokenLive`
   * re-reads on every request, so that write is what refuses the token on its
   * next use. `machine_tokens` is the per-machine ledger and is kept in step so
   * the two never disagree about what is live. The caller has already resolved
   * the machine inside its tenant, and every write here is tenant-scoped too.
   */
  async revokeMachineTokens(context: TenantContext, machineId: string): Promise<number> {
    if (!this.dataSource) {
      let revoked = 0;
      for (const [hash, owner] of this.devMachineTokens) {
        if (owner.tenantId !== context.tenantId || owner.machineId !== machineId) continue;
        this.devMachineTokens.delete(hash);
        revoked += 1;
      }
      return revoked;
    }
    return this.inTenant(context, async (manager) => {
      const revokedAt = new Date();
      const live = { tenantId: context.tenantId, machineId, revokedAt: IsNull() };
      await manager.getRepository(MachineTokenEntity).update(live, { revokedAt });
      const result = await manager.getRepository(AuthIdentityEntity).update({ ...live, kind: "machine_token" }, { revokedAt });
      return result.affected ?? 0;
    });
  }

  async authenticateApiKey(secret: string): Promise<TenantContext | null> {
    const prefix = secret.slice(0, 15);
    if (this.dataSource) {
      const identity = await this.dataSource.getRepository(AuthIdentityEntity).findOneBy({ kind: "api_key", lookupKey: prefix, revokedAt: IsNull() });
      if (!identity || !verifySecret(secret, identity.secretHash)) return null;
      const now = new Date();
      await this.dataSource.getRepository(AuthIdentityEntity).update({ id: identity.id }, { lastUsedAt: now });
      await this.inTenant({ tenantId: identity.tenantId, userId: identity.userId, scopes: identity.scopes, authType: "api_key" }, async (manager) => {
        await manager.getRepository(ApiKeyEntity).update({ prefix, tenantId: identity.tenantId }, { lastUsedAt: now });
      });
      // The identity row, not the api_keys row: it is what revocation writes to
      // and what `apiKeyCredentialLive` re-reads. Without a database the two
      // are one record, so the dev path names that one instead.
      return { tenantId: identity.tenantId, userId: identity.userId, scopes: identity.scopes, authType: "api_key", credentialId: identity.id };
    }
    const row = this.devApiKeys.get(prefix);
    return row && !row.revokedAt && verifySecret(secret, row.secretHash)
      ? { tenantId: row.tenantId, userId: row.userId, scopes: row.scopes, authType: "api_key", credentialId: row.id }
      : null;
  }

  /**
   * Whether a machine token has been revoked, ignoring its expiry.
   *
   * For a request that outlives its own authentication: the command stream is
   * one request held open for as long as the machine listens, past the hour its
   * token was minted for. Expiry is checked when it connects. Revocation has to
   * be checked while it runs, or a leaked token keeps a stream open for good.
   */
  async machineTokenRevoked(token: string): Promise<boolean> {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    if (!this.dataSource) return !this.devMachineTokens.has(tokenHash);
    return !await this.dataSource.getRepository(AuthIdentityEntity).existsBy({ kind: "machine_token", lookupKey: tokenHash, revokedAt: IsNull() });
  }

  /** Re-checks a machine token against the identity it was issued against, on every request. */
  async machineTokenLive(token: string, claims: TokenClaims): Promise<boolean> {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    if (!this.dataSource) {
      const owner = this.devMachineTokens.get(tokenHash);
      return owner?.tenantId === claims.tenantId && owner.machineId === claims.machineId;
    }
    const identity = await this.dataSource.getRepository(AuthIdentityEntity).findOneBy({ kind: "machine_token", lookupKey: tokenHash, revokedAt: IsNull() });
    if (!identity || identity.tenantId !== claims.tenantId || identity.userId !== claims.sub || identity.machineId !== claims.machineId
      || !identity.expiresAt || identity.expiresAt <= new Date()) return false;
    await this.dataSource.getRepository(AuthIdentityEntity).update({ id: identity.id }, { lastUsedAt: new Date() });
    return true;
  }
}
