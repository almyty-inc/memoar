import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Query, Redirect, Post } from "@nestjs/common";

import type { TenantContext } from "../archive-store.js";

import { Public, Tenant } from "./decorators.js";

import { AuthService } from "./auth.service.js";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  login(@Body() body: { email: string; password: string }): Promise<Record<string, unknown>> {
    return this.auth.login(body.email, body.password);
  }

  @Public()
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
  createApiKey(@Tenant() context: TenantContext, @Body() body: { name: string; scopes: string[] }): Promise<{ apiKey: Record<string, unknown>; secret: string }> {
    return this.auth.createApiKey(context, body.name, body.scopes);
  }

  @Post("machine-token")
  issueMachineToken(@Tenant() context: TenantContext, @Body() body: { machineId: string }): Promise<{ token: string; expiresAt: string }> {
    return this.auth.issueMachineToken(context, body.machineId);
  }

  @Delete("api-keys/:keyId")
  @HttpCode(204)
  async revokeApiKey(@Tenant() context: TenantContext, @Param("keyId", ParseUUIDPipe) keyId: string): Promise<void> {
    // Idempotent for a key that exists; 404 only when the id is unknown.
    if (!await this.auth.revokeApiKey(context, keyId)) throw new NotFoundException("API key not found");
  }
}
