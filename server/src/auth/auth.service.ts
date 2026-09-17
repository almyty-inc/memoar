import { ConflictException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";

import { DataSource, IsNull } from "typeorm";

import type { ArchiveStore, TenantContext } from "../archive-store.js";

import { bootstrapAccount, PASSWORD_SCOPES, registrationClosed, signupOpen } from "../bootstrap-account.js";

import { AuthIdentityEntity, UserEntity } from "../entities.js";

import { uuidV7 } from "../ids.js";

import { ARCHIVE_STORE } from "../tokens.js";

import { hashSecret, TokenService, verifySecret } from "./tokens.js";

import { CredentialsService } from "./credentials.service.js";

import { resolveOAuthAccount, type DevAccount } from "./oauth-accounts.js";

import { BrowserSessionService } from "./browser-sessions.js";

import { callbackUrl, exchangeCodeForProfile, isOAuthProvider, providerCredentials } from "./oauth-provider.js";

import type { TokenClaims } from "./types.js";

/** The scopes the MCP handshake mints, and nothing else mints. */
const MCP_SESSION_SCOPES = ["mcp:use"];

@Injectable()
export class AuthService {
  private readonly devUsers = new Map<string, DevAccount>();

  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(DataSource) private readonly dataSource: DataSource | null,
    @Inject(ARCHIVE_STORE) private readonly store: ArchiveStore,
    @Inject(BrowserSessionService) private readonly sessions: BrowserSessionService,
    @Inject(CredentialsService) private readonly credentials: CredentialsService,
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

  async login(email: string, password: string): Promise<{ accessToken: string; expiresAt: string; user: { id: string; email: string; displayName: string } }> {
    const normalizedEmail = email.trim().toLowerCase();
    let user: DevAccount | null = null;
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
   * What this deployment accepts, so the client offers only what works.
   *
   * A page that shows "Continue with GitHub" on a server holding no GitHub
   * credentials is a button that fails when pressed, and it is the only way in
   * that page offers.
   */
  authMethods(): { password: boolean; signup: "open" | "closed"; oauth: string[] } {
    const oauth: string[] = [];
    if (process.env.GITHUB_CLIENT_ID) oauth.push("github");
    if (process.env.GOOGLE_CLIENT_ID) oauth.push("google");
    return { password: true, signup: signupOpen() ? "open" : "closed", oauth };
  }

  /**
   * Creates an account, its tenant and its password identity.
   *
   * One tenant per account: an archive is somebody's own, and joining an
   * existing one is what sharing and teams are for.
   *
   * The three rows are written in one transaction, because a user with no
   * identity cannot sign in and an identity with no user is a token subject
   * that resolves to nothing — either half alone is an account that looks
   * created and is not.
   */
  async register(email: string, password: string, displayName?: string): Promise<{ accessToken: string; expiresAt: string; user: { id: string; email: string; displayName: string } }> {
    if (!signupOpen()) throw registrationClosed();
    const normalizedEmail = email.trim().toLowerCase();
    const name = displayName?.trim() || normalizedEmail.split("@")[0] || normalizedEmail;
    const userId = uuidV7();
    const tenantId = uuidV7();

    // Without a database, accounts live in memory for as long as the process
    // does. Refusing here instead would leave anyone running locally at the
    // same dead end this endpoint exists to remove.
    if (!this.dataSource) {
      if (this.devUsers.has(normalizedEmail)) {
        throw new ConflictException({
          type: "https://memoar.dev/problems/account-exists",
          title: "An account with that address already exists",
          status: 409,
          code: "account_exists",
        });
      }
      this.devUsers.set(normalizedEmail, {
        id: userId, tenantId, email: normalizedEmail, passwordHash: hashSecret(password), displayName: name,
      });
      const local = this.tokens.issue({ sub: userId, tenantId, scopes: PASSWORD_SCOPES, type: "browser" }, 3600);
      return { accessToken: local.token, expiresAt: local.expiresAt, user: { id: userId, email: normalizedEmail, displayName: name } };
    }

    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(UserEntity).insert({
          id: userId, email: normalizedEmail, displayName: name, passwordHash: hashSecret(password),
        });
        await manager.getRepository(AuthIdentityEntity).insert({
          id: uuidV7(),
          kind: "password",
          lookupKey: normalizedEmail,
          tenantId,
          userId,
          secretHash: hashSecret(password),
          scopes: PASSWORD_SCOPES,
          machineId: null, expiresAt: null, revokedAt: null, lastUsedAt: null,
        });
      });
    } catch (error) {
      // Uniqueness is enforced by the database rather than by looking first:
      // two registrations for one address arriving together would both find
      // nothing and both insert.
      if ((error as { code?: string }).code === "23505") {
        throw new ConflictException({
          type: "https://memoar.dev/problems/account-exists",
          title: "An account with that address already exists",
          status: 409,
          code: "account_exists",
        });
      }
      throw error;
    }

    const issued = this.tokens.issue({ sub: userId, tenantId, scopes: PASSWORD_SCOPES, type: "browser" }, 3600);
    return { accessToken: issued.token, expiresAt: issued.expiresAt, user: { id: userId, email: normalizedEmail, displayName: name } };
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
    if (!isOAuthProvider(normalized)) throw new UnauthorizedException("Unsupported OAuth provider");
    const { clientId } = providerCredentials(normalized);
    const authorize = normalized === "github" ? "https://github.com/login/oauth/authorize" : "https://accounts.google.com/o/oauth2/v2/auth";
    const url = new URL(authorize);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", callbackUrl(normalized));
    url.searchParams.set("scope", normalized === "github" ? "read:user user:email" : "openid email profile");
    url.searchParams.set("state", this.tokens.issueOAuthState(normalized));
    if (normalized === "google") url.searchParams.set("response_type", "code");
    return url.toString();
  }

  /**
   * Turns a provider callback into a session on this archive.
   *
   * Two things this used to get wrong, both of which handed out an account the
   * operator had not agreed to:
   *
   * The signup gate was never consulted, so a closed archive that happened to
   * have GITHUB_CLIENT_ID set let anybody with a GitHub account in, fully
   * scoped, while /auth/register correctly refused them.
   *
   * And the tenant was the user's own id rather than the tenant on their
   * identity, so the same person arriving by password and by provider got two
   * tenants and, the second time, an empty archive. No identity row was written
   * at all, which is also why looking a colleague up by email to add them to a
   * team could never find anybody who had only ever signed in with a provider.
   */
  async completeOAuth(provider: string, code: string, state: string): Promise<string> {
    const normalized = provider.toLowerCase();
    if (!isOAuthProvider(normalized) || !this.tokens.verifyOAuthState(state, normalized)) {
      throw new UnauthorizedException("Invalid OAuth state");
    }
    const profile = await exchangeCodeForProfile(normalized, code);
    const user = await resolveOAuthAccount(this.dataSource, this.devUsers, profile);
    const issued = this.tokens.issue({ sub: user.id, tenantId: user.tenantId, scopes: PASSWORD_SCOPES, type: "browser" }, 3600);
    const returnUrl = new URL(process.env.WEB_ORIGIN?.split(",")[0] ?? "http://localhost:3000/oauth/callback");
    returnUrl.hash = new URLSearchParams({ access_token: issued.token, expires_at: issued.expiresAt }).toString();
    return returnUrl.toString();
  }

  /** Signs one browser token out, so a stolen or finished session stops working before it expires. */
  async logout(token: string): Promise<void> {
    const claims = this.tokens.verify(token);
    if (claims && claims.type === "browser") await this.sessions.revoke(claims);
  }

  createApiKey(context: TenantContext, name: string, scopes: string[]): Promise<{ apiKey: Record<string, unknown>; secret: string }> {
    return this.credentials.createApiKey(context, name, scopes);
  }

  listApiKeys(context: TenantContext): Promise<{ items: Record<string, unknown>[] }> {
    return this.credentials.listApiKeys(context);
  }

  revokeApiKey(context: TenantContext, keyId: string): Promise<boolean> {
    return this.credentials.revokeApiKey(context, keyId);
  }

  issueMachineToken(context: TenantContext, machineId: string): Promise<{ token: string; expiresAt: string }> {
    return this.credentials.issueMachineToken(context, machineId);
  }

  authenticateApiKey(secret: string): Promise<TenantContext | null> {
    return this.credentials.authenticateApiKey(secret);
  }

  async authenticateBearer(token: string): Promise<TenantContext | null> {
    const claims = this.tokens.verify(token);
    if (!claims) return null;
    const context: TenantContext = {
      tenantId: claims.tenantId, userId: claims.sub, scopes: claims.scopes, authType: claims.type,
      ...(claims.machineId ? { machineId: claims.machineId } : {}),
    };
    if (claims.type === "browser") return await this.browserTokenLive(claims) ? context : null;
    if (!claims.machineId) return null;
    if (!await this.credentials.machineTokenLive(token, claims)) return null;
    const machine = await this.store.getMachine(context, claims.machineId);
    if (!machine) return null;
    machine.lastSeenAt = new Date().toISOString();
    await this.store.saveMachine(context, machine);
    return context;
  }

  /**
   * Whether a browser token still stands for something.
   *
   * A browser token used to be trusted on its signature alone: this method did
   * not exist and `authenticateBearer` returned before any lookup, so a machine
   * token was re-checked against `auth_identities` on every request while a
   * browser token — the credential a person actually holds — was checked on
   * none. Deleting the account, revoking its identity or signing out changed
   * nothing for the full hour the token had left.
   *
   * The credential behind the token decides. A token carrying mcp:use and
   * nothing else is one the MCP handshake minted out of an API key, so it lives
   * exactly as long as an unrevoked key of that account's does; anything else
   * is a sign-in, and lives as long as the sign-in identity does.
   */
  private async browserTokenLive(claims: TokenClaims): Promise<boolean> {
    if (await this.sessions.isRevoked(claims)) return false;
    const derivedFromApiKey = claims.scopes.length === MCP_SESSION_SCOPES.length
      && MCP_SESSION_SCOPES.every((scope) => claims.scopes.includes(scope));
    if (derivedFromApiKey) return this.credentials.hasLiveApiKey(claims.tenantId, claims.sub);
    if (!this.dataSource) {
      return [...this.devUsers.values()].some((user) => user.id === claims.sub && user.tenantId === claims.tenantId);
    }
    return this.dataSource.getRepository(AuthIdentityEntity).existsBy(
      // The tenant is re-read from the identity, not taken from the token: a
      // signed token naming another tenant must still resolve to nothing.
      (["password", "oauth"] as const).map((kind) => ({
        kind, tenantId: claims.tenantId, userId: claims.sub, revokedAt: IsNull(),
      })),
    );
  }
}
