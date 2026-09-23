import { Body, Controller, Delete, Get, Headers, HttpCode, NotFoundException, Param, ParseUUIDPipe, Query, Redirect, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";

import type { TenantContext } from "../archive-store.js";

import { Public, Tenant } from "./decorators.js";

import { AuthService } from "./auth.service.js";
import { ChangePasswordDto, CreateApiKeyDto, EmailLoginDto, EmailRegisterDto, IssueMachineTokenDto } from "./auth.dto.js";
import { clearedOAuthStateCookie, oauthStateCookie, oauthStateNonce } from "./oauth-state-cookie.js";
import type { RequestLike } from "./types.js";
import { CREDENTIAL_LIMIT, Throttle } from "../rate-limit.js";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  // Unauthenticated: the only thing between an attacker and every password
  // they care to try is how often they are allowed to ask.
  @Throttle(CREDENTIAL_LIMIT)
  login(@Body() body: EmailLoginDto): Promise<Record<string, unknown>> {
    return this.auth.login(body.email, body.password);
  }

  @Public()
  @Post("register")
  // The same budget as login: without it this is a way to mint accounts in bulk
  // and to learn which addresses already have one.
  @Throttle(CREDENTIAL_LIMIT)
  register(@Body() body: EmailRegisterDto): Promise<Record<string, unknown>> {
    return this.auth.register(body.email, body.password, body.displayName);
  }

  /**
   * What this deployment accepts, so a client offers only what works rather
   * than a provider the server has no credentials for.
   */
  @Public()
  @Get("methods")
  methods(): { password: boolean; signup: string; oauth: string[] } {
    return this.auth.authMethods();
  }

  /**
   * Ends this session.
   *
   * Without it a browser token was valid until it expired whatever anyone did:
   * signing out cleared the client and left the credential working. The token
   * itself is the argument because the id that identifies it is in the token,
   * not in the context the guard builds.
   */
  @Post("logout")
  @HttpCode(204)
  logout(@Headers("authorization") authorization?: string): Promise<void> {
    // A caller authenticated by `x-memoar-key` reaches this handler with no
    // Authorization header at all, and slicing it threw — so signing out with
    // an API key in hand answered 500 instead of "there is no session to end".
    // Signing out is idempotent; having nothing to sign out is the same case.
    if (!authorization?.startsWith("Bearer ")) return Promise.resolve();
    return this.auth.logout(authorization.slice("Bearer ".length));
  }

  /**
   * The signed-in identity. Login returns the user too, but a browser reload
   * keeps only the token, so without this the client has to either invent a
   * name or persist one it can no longer verify.
   */
  @Get("me")
  me(@Tenant() context: TenantContext): Promise<Record<string, unknown>> {
    return this.auth.currentUser(context);
  }

  /**
   * Replaces the signed-in account's password and ends its other sessions.
   *
   * On the credential budget because it answers "is this the password?" to
   * anybody holding a session, including a stolen one.
   */
  @Post("password")
  @HttpCode(204)
  @Throttle(CREDENTIAL_LIMIT)
  changePassword(
    @Tenant() context: TenantContext,
    @Body() body: ChangePasswordDto,
    @Headers("authorization") authorization?: string,
  ): Promise<void> {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
    return this.auth.changePassword(context, token, body.currentPassword, body.newPassword);
  }

  @Public()
  @Throttle(CREDENTIAL_LIMIT)
  @Get("oauth/:provider")
  @Redirect(undefined, 302)
  beginOAuth(@Param("provider") provider: string, @Res({ passthrough: true }) response: Response): { url: string } {
    const begun = this.auth.beginOAuth(provider);
    // The half of the state that stays with this browser. Without it the
    // callback proves only that some browser somewhere started a sign-in.
    response.setHeader("Set-Cookie", oauthStateCookie(begun.stateNonce));
    return { url: begun.url };
  }

  @Public()
  @Get("oauth/:provider/callback")
  @Redirect(undefined, 302)
  async completeOAuth(
    @Param("provider") provider: string,
    @Query("code") code: string,
    @Query("state") state: string,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ url: string }> {
    const nonce = oauthStateNonce(request.headers.cookie);
    // Cleared whatever happens next, which is what makes one state good for one
    // callback: a replay reaches a browser that no longer holds the nonce.
    response.setHeader("Set-Cookie", clearedOAuthStateCookie());
    return { url: await this.auth.completeOAuth(provider, code, state, nonce) };
  }

  @Get("api-keys")
  listApiKeys(@Tenant() context: TenantContext): Promise<{ items: Record<string, unknown>[] }> {
    return this.auth.listApiKeys(context);
  }

  @Post("api-keys")
  createApiKey(@Tenant() context: TenantContext, @Body() body: CreateApiKeyDto): Promise<{ apiKey: Record<string, unknown>; secret: string }> {
    return this.auth.createApiKey(context, body.name, body.scopes);
  }

  @Throttle(CREDENTIAL_LIMIT)
  @Post("machine-token")
  issueMachineToken(@Tenant() context: TenantContext, @Body() body: IssueMachineTokenDto): Promise<{ token: string; expiresAt: string }> {
    return this.auth.issueMachineToken(context, body.machineId);
  }

  @Delete("api-keys/:keyId")
  @HttpCode(204)
  async revokeApiKey(@Tenant() context: TenantContext, @Param("keyId", ParseUUIDPipe) keyId: string): Promise<void> {
    // Idempotent for a key that exists; 404 only when the id is unknown.
    if (!await this.auth.revokeApiKey(context, keyId)) throw new NotFoundException("API key not found");
  }
}
