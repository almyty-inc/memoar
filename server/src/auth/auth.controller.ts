import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Query, Redirect, Post } from "@nestjs/common";

import type { TenantContext } from "../archive-store.js";

import { Public, Tenant } from "./decorators.js";

import { AuthService } from "./auth.service.js";
import { CreateApiKeyDto, EmailLoginDto, IssueMachineTokenDto } from "./auth.dto.js";
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

  /**
   * The signed-in identity. Login returns the user too, but a browser reload
   * keeps only the token, so without this the client has to either invent a
   * name or persist one it can no longer verify.
   */
  @Get("me")
  me(@Tenant() context: TenantContext): Promise<Record<string, unknown>> {
    return this.auth.currentUser(context);
  }

  @Public()
  @Throttle(CREDENTIAL_LIMIT)
  @Get("oauth/:provider")
  @Redirect(undefined, 302)
  beginOAuth(@Param("provider") provider: string): { url: string } {
    return { url: this.auth.beginOAuth(provider) };
  }

  @Public()
  @Get("oauth/:provider/callback")
  @Redirect(undefined, 302)
  async completeOAuth(
    @Param("provider") provider: string,
    @Query("code") code: string,
    @Query("state") state: string,
  ): Promise<{ url: string }> {
    return { url: await this.auth.completeOAuth(provider, code, state) };
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
