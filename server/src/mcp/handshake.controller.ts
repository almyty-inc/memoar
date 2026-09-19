import { Body, Controller, ForbiddenException, Inject, Post } from "@nestjs/common";

import type { TenantContext } from "../archive-store.js";
import { RequireScopes, Tenant, TokenService } from "../auth.js";
import { McpHandshakeDto } from "../mcp.dto.js";
import { McpToolRegistry } from "./registry.js";

/** An hour: long enough for a session, short enough to be worth expiring. */
const MCP_TOKEN_TTL_SECONDS = 3600;

@Controller("mcp/auth")
export class McpHandshakeController {
  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(McpToolRegistry) private readonly registry: McpToolRegistry,
  ) {}

  /**
   * Exchanges an API key for a short-lived bearer token.
   *
   * The MCP endpoint authenticates an API key through the x-memoar-key header,
   * and a client that cannot send a custom header — Codex, which takes only a
   * bearer token from an environment variable — had no way in. This says so in
   * a token rather than in documentation: the handshake was documented as
   * minting one and never did.
   *
   * The token carries mcp:use alone, so a leaked one reads no archive directly.
   *
   * Two things it now records that it did not:
   *
   * Its own kind. It used to be minted as `type: "browser"` and recognised
   * later by carrying mcp:use and nothing else, which is a guess about a scope
   * list rather than a fact about the token — and one that would have misread
   * every handshake token the day a second scope was added to the grant.
   *
   * And the key it came from. Without that, revocation could only ask whether
   * the *account* still held an unrevoked key, so an account with two keys
   * could revoke the one a token was minted from and the token would keep
   * reading whole sessions through MCP until the other key was revoked too.
   */
  @Post("handshake")
  @RequireScopes("mcp:use")
  handshake(@Tenant() context: TenantContext, @Body() body: McpHandshakeDto): Record<string, unknown> {
    if (context.authType !== "api_key" && context.authType !== "dev") {
      // Was `throw new Error(...)`, which is a 500: the caller used the wrong
      // kind of credential, which is theirs to fix and ours to say plainly.
      throw new ForbiddenException({
        type: "https://memoar.dev/problems/api-key-required",
        title: "API key required",
        status: 403,
        code: "mcp_api_key_required",
        detail: "The MCP handshake exchanges an API key for a session token; sign in with an API key instead.",
      });
    }
    const issued = this.tokens.issue(
      {
        sub: context.userId,
        tenantId: context.tenantId,
        scopes: ["mcp:use"],
        type: "mcp",
        // Absent only for development auth, which exchanges no key; a token
        // naming no credential is accepted nowhere else.
        ...(context.credentialId ? { credentialId: context.credentialId } : {}),
      },
      MCP_TOKEN_TTL_SECONDS,
    );
    return {
      endpoint: "/mcp",
      tools: this.registry.names,
      clientName: body.clientName,
      protocolVersion: body.protocolVersion,
      accessToken: issued.token,
      expiresAt: issued.expiresAt,
    };
  }
}
