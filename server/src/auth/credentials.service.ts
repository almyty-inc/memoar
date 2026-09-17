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
 * The credentials a program holds: API keys, and the short-lived machine tokens
 * the capture agent runs on. Split from AuthService, which is about people
 * signing in, so neither file has to be read to understand the other.
 */
@Injectable()
export class CredentialsService {
  private readonly devApiKeys = new Map<string, DevApiKey>();
  private readonly devMachineTokens = new Set<string>();

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
   * Asked of a bearer token that carries mcp:use alone, which is what the MCP
   * handshake mints out of an API key. Without this, revoking the key left the
   * token it produced working for the rest of its hour with nothing able to
   * stop it — a credential derived from a revoked credential.
   */
  async hasLiveApiKey(tenantId: string, userId: string): Promise<boolean> {
    if (this.dataSource) {
      return this.dataSource.getRepository(AuthIdentityEntity).existsBy({ kind: "api_key", tenantId, userId, revokedAt: IsNull() });
    }
    return [...this.devApiKeys.values()].some((key) => !key.revokedAt && key.tenantId === tenantId && key.userId === userId);
  }

  async issueMachineToken(context: TenantContext, machineId: string): Promise<{ token: string; expiresAt: string }> {
    const machine = await this.store.getMachine(context, machineId);
    if (!machine) throw new UnauthorizedException("Machine is outside the active tenant");
    machine.lastSeenAt = new Date().toISOString();
    await this.store.saveMachine(context, machine);
    const issued = this.tokens.issue({
      sub: context.userId, tenantId: context.tenantId, scopes: MACHINE_SCOPES, type: "machine", machineId,
    }, 900);
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
    else this.devMachineTokens.add(tokenHash);
    return issued;
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
      return { tenantId: identity.tenantId, userId: identity.userId, scopes: identity.scopes, authType: "api_key" };
    }
    const row = this.devApiKeys.get(prefix);
    return row && !row.revokedAt && verifySecret(secret, row.secretHash)
      ? { tenantId: row.tenantId, userId: row.userId, scopes: row.scopes, authType: "api_key" }
      : null;
  }

  /** Re-checks a machine token against the identity it was issued against, on every request. */
  async machineTokenLive(token: string, claims: TokenClaims): Promise<boolean> {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    if (!this.dataSource) return this.devMachineTokens.has(tokenHash);
    const identity = await this.dataSource.getRepository(AuthIdentityEntity).findOneBy({ kind: "machine_token", lookupKey: tokenHash, revokedAt: IsNull() });
    if (!identity || identity.tenantId !== claims.tenantId || identity.userId !== claims.sub || identity.machineId !== claims.machineId
      || !identity.expiresAt || identity.expiresAt <= new Date()) return false;
    await this.dataSource.getRepository(AuthIdentityEntity).update({ id: identity.id }, { lastUsedAt: new Date() });
    return true;
  }
}
