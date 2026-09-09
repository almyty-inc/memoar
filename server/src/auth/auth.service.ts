import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";

import { createHash, randomBytes } from "node:crypto";

import { DataSource, IsNull, type EntityManager } from "typeorm";

import type { ArchiveStore, TenantContext } from "../archive-store.js";

import { bootstrapAccount, PASSWORD_SCOPES } from "../bootstrap-account.js";

import { ApiKeyEntity, AuthIdentityEntity, MachineTokenEntity, UserEntity } from "../entities.js";

import { uuidV7 } from "../ids.js";

import { ARCHIVE_STORE } from "../tokens.js";

import { hashSecret, TokenService, verifySecret, type DevApiKey } from "./tokens.js";

@Injectable()
export class AuthService {
  private readonly devApiKeys = new Map<string, DevApiKey>();
  private readonly devUsers = new Map<string, { id: string; tenantId: string; email: string; passwordHash: string; displayName: string }>();
  private readonly devMachineTokens = new Set<string>();

  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(DataSource) private readonly dataSource: DataSource | null,
    @Inject(ARCHIVE_STORE) private readonly store: ArchiveStore,
  ) {
    // Without a database there is nowhere to keep accounts, so the one the
    // operator named in the environment lives in memory for as long as the
    // process does. Absent those variables nobody can sign in, which is the
    // right answer for a server with no store behind it.
    const account = bootstrapAccount();
    if (!dataSource && account) {
      this.devUsers.set(account.email, {
        id: account.userId,
        tenantId: account.tenantId,
        email: account.email,
        passwordHash: hashSecret(account.password),
        displayName: account.displayName,
      });
    }
  }

  private async inTenant<T>(context: TenantContext, operation: (manager: EntityManager) => Promise<T>): Promise<T> {
    if (!this.dataSource) throw new Error("postgres_not_configured");
    return this.dataSource.transaction(async (manager) => {
      await manager.query("SELECT set_config('memoar.tenant_id', $1, true)", [context.tenantId]);
      return operation(manager);
    });
  }

  async login(email: string, password: string): Promise<{ accessToken: string; expiresAt: string; user: { id: string; email: string; displayName: string } }> {
    const normalizedEmail = email.trim().toLowerCase();
    let user: { id: string; tenantId: string; email: string; passwordHash: string; displayName: string } | null = null;
    if (this.dataSource) {
      const identity = await this.dataSource.getRepository(AuthIdentityEntity).findOneBy({ kind: "password", lookupKey: normalizedEmail, revokedAt: IsNull() });
      const row = identity ? await this.dataSource.getRepository(UserEntity).findOneBy({ id: identity.userId }) : null;
      if (identity && row) user = { ...row, tenantId: identity.tenantId, passwordHash: identity.secretHash };
    } else user = this.devUsers.get(normalizedEmail) ?? null;
    if (!user || !verifySecret(password, user.passwordHash)) throw new UnauthorizedException("Invalid credentials");
    const issued = this.tokens.issue({
      sub: user.id,
      tenantId: user.tenantId,
      scopes: PASSWORD_SCOPES,
      type: "browser",
    }, 3600);
    return { accessToken: issued.token, expiresAt: issued.expiresAt, user: { id: user.id, email: user.email, displayName: user.displayName } };
  }

  /**
   * Resolves the caller's own record from the token's subject. The token is the
   * only trusted input here: the id is never taken from the request, so one
   * tenant cannot read another's profile by asking for it.
   */
  async currentUser(context: TenantContext): Promise<{ id: string; email: string; displayName: string }> {
    if (this.dataSource) {
      const row = await this.dataSource.getRepository(UserEntity).findOneBy({ id: context.userId });
      if (!row) throw new UnauthorizedException("Signed-in user no longer exists");
      return { id: row.id, email: row.email, displayName: row.displayName };
    }
    const user = [...this.devUsers.values()].find((candidate) => candidate.id === context.userId);
    if (!user) throw new UnauthorizedException("Signed-in user no longer exists");
    return { id: user.id, email: user.email, displayName: user.displayName };
  }

  beginOAuth(provider: string): string {
    const normalized = provider.toLowerCase();
    if (normalized !== "github" && normalized !== "google") throw new UnauthorizedException("Unsupported OAuth provider");
    const clientId = normalized === "github" ? process.env.GITHUB_CLIENT_ID : process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw new UnauthorizedException(`${normalized} OAuth is not configured`);
    const callback = `${process.env.MEMOAR_PUBLIC_URL ?? "http://localhost:4000"}/v1/auth/oauth/${normalized}/callback`;
    const authorize = normalized === "github" ? "https://github.com/login/oauth/authorize" : "https://accounts.google.com/o/oauth2/v2/auth";
    const url = new URL(authorize);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", callback);
    url.searchParams.set("scope", normalized === "github" ? "read:user user:email" : "openid email profile");
    url.searchParams.set("state", this.tokens.issueOAuthState(normalized));
    if (normalized === "google") url.searchParams.set("response_type", "code");
    return url.toString();
  }

  async completeOAuth(provider: string, code: string, state: string): Promise<string> {
    const normalized = provider.toLowerCase();
    if ((normalized !== "github" && normalized !== "google") || !this.tokens.verifyOAuthState(state, normalized)) {
      throw new UnauthorizedException("Invalid OAuth state");
    }
    const clientId = normalized === "github" ? process.env.GITHUB_CLIENT_ID : process.env.GOOGLE_CLIENT_ID;
    const clientSecret = normalized === "github" ? process.env.GITHUB_CLIENT_SECRET : process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new UnauthorizedException(`${normalized} OAuth is not configured`);
    const callback = `${process.env.MEMOAR_PUBLIC_URL ?? "http://localhost:4000"}/v1/auth/oauth/${normalized}/callback`;
    const tokenEndpoint = normalized === "github" ? "https://github.com/login/oauth/access_token" : "https://oauth2.googleapis.com/token";
    const tokenResponse = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callback, ...(normalized === "google" ? { grant_type: "authorization_code" } : {}) }),
    });
    if (!tokenResponse.ok) throw new UnauthorizedException("OAuth token exchange failed");
    const tokenPayload = await tokenResponse.json() as { access_token?: string };
    if (!tokenPayload.access_token) throw new UnauthorizedException("OAuth provider returned no access token");
    const profileEndpoint = normalized === "github" ? "https://api.github.com/user" : "https://openidconnect.googleapis.com/v1/userinfo";
    const profileResponse = await fetch(profileEndpoint, { headers: { authorization: `Bearer ${tokenPayload.access_token}`, accept: "application/json" } });
    if (!profileResponse.ok) throw new UnauthorizedException("OAuth profile lookup failed");
    const profile = await profileResponse.json() as { email?: string; name?: string; login?: string };
    let email = profile.email;
    if (!email && normalized === "github") {
      const emailResponse = await fetch("https://api.github.com/user/emails", { headers: { authorization: `Bearer ${tokenPayload.access_token}`, accept: "application/json" } });
      const emails = emailResponse.ok ? await emailResponse.json() as { email: string; primary?: boolean; verified?: boolean }[] : [];
      email = emails.find((candidate) => candidate.primary && candidate.verified)?.email ?? emails.find((candidate) => candidate.verified)?.email;
    }
    if (!email) throw new UnauthorizedException("OAuth provider did not supply a verified email");
    const normalizedEmail = email.toLowerCase();
    const displayName = profile.name?.trim() || profile.login?.trim() || normalizedEmail;
    let user: { id: string; email: string; displayName: string };
    if (this.dataSource) {
      const repository = this.dataSource.getRepository(UserEntity);
      const existing = await repository.findOneBy({ email: normalizedEmail });
      const row = existing ?? await repository.save({ id: uuidV7(), email: normalizedEmail, displayName, passwordHash: null });
      user = { id: row.id, email: row.email, displayName: row.displayName };
    } else {
      const existing = this.devUsers.get(normalizedEmail);
      const id = existing?.id ?? uuidV7();
      if (!existing) this.devUsers.set(normalizedEmail, { id, tenantId: id, email: normalizedEmail, displayName, passwordHash: hashSecret(randomBytes(32).toString("hex")) });
      user = { id, email: normalizedEmail, displayName };
    }
    const issued = this.tokens.issue({ sub: user.id, tenantId: user.id, scopes: ["archive:read", "archive:write", "sharing:write", "keys:write", "machines:write", "ingest:write", "mcp:use"], type: "browser" }, 3600);
    const returnUrl = new URL(process.env.WEB_ORIGIN?.split(",")[0] ?? "http://localhost:3000/oauth/callback");
    returnUrl.hash = new URLSearchParams({ access_token: issued.token, expires_at: issued.expiresAt }).toString();
    return returnUrl.toString();
  }

  async createApiKey(context: TenantContext, name: string, scopes: string[]): Promise<{ apiKey: Record<string, unknown>; secret: string }> {
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
    return {
      apiKey: { id, name, prefix, scopes, createdAt, lastUsedAt: null },
      secret,
    };
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

  async issueMachineToken(context: TenantContext, machineId: string): Promise<{ token: string; expiresAt: string }> {
    const machine = await this.store.getMachine(context, machineId);
    if (!machine) throw new UnauthorizedException("Machine is outside the active tenant");
    machine.lastSeenAt = new Date().toISOString();
    await this.store.saveMachine(context, machine);
    const issued = this.tokens.issue({
      sub: context.userId,
      tenantId: context.tenantId,
      scopes: ["ingest:write", "machine:heartbeat", "materialize:read"],
      type: "machine",
      machineId,
    }, 900);
    const tokenHash = createHash("sha256").update(issued.token).digest("hex");
    if (this.dataSource) await this.inTenant(context, async (manager) => {
      await manager.getRepository(MachineTokenEntity).save({
        id: uuidV7(), tenantId: context.tenantId, machineId, tokenHash,
        expiresAt: new Date(issued.expiresAt), revokedAt: null,
      });
      await manager.getRepository(AuthIdentityEntity).save({
        id: uuidV7(), kind: "machine_token", lookupKey: tokenHash, tenantId: context.tenantId, userId: context.userId,
        secretHash: tokenHash, scopes: ["ingest:write", "machine:heartbeat", "materialize:read"], machineId,
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

  async authenticateBearer(token: string): Promise<TenantContext | null> {
    const claims = this.tokens.verify(token);
    if (!claims) return null;
    const context: TenantContext = {
      tenantId: claims.tenantId, userId: claims.sub, scopes: claims.scopes, authType: claims.type,
      ...(claims.machineId ? { machineId: claims.machineId } : {}),
    };
    if (claims.type === "browser") return context;
    if (!claims.machineId) return null;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    if (this.dataSource) {
      const identity = await this.dataSource.getRepository(AuthIdentityEntity).findOneBy({ kind: "machine_token", lookupKey: tokenHash, revokedAt: IsNull() });
      if (!identity || identity.tenantId !== claims.tenantId || identity.userId !== claims.sub || identity.machineId !== claims.machineId
        || !identity.expiresAt || identity.expiresAt <= new Date()) return null;
      await this.dataSource.getRepository(AuthIdentityEntity).update({ id: identity.id }, { lastUsedAt: new Date() });
    } else if (!this.devMachineTokens.has(tokenHash)) return null;
    const machine = await this.store.getMachine(context, claims.machineId);
    if (!machine) return null;
    machine.lastSeenAt = new Date().toISOString();
    await this.store.saveMachine(context, machine);
    return context;
  }
}

