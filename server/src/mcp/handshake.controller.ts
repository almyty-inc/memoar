import { Body, Controller, ForbiddenException, Inject, Post } from "@nestjs/common";

import type { TenantContext } from "../archive-store.js";
import { RequireScopes, Tenant, TokenService } from "../auth.js";
import { McpHandshakeDto } from "../mcp.dto.js";
import { McpToolRegistry } from "./registry.js";
import { mcpTokenScopes } from "./tool-scopes.js";

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
   * What it carries is the key's own grant, narrowed to what MCP can spend.
   *
   * It used to carry `mcp:use` and nothing else, which was the whole of the
   * gate on every write tool — so a key refused `POST /v1/annotations` wrote
   * annotations over MCP all the same. Gating those tools properly means the
   * token has to be able to say the caller held `archive:write`; minting that
   * unconditionally would make the handshake an escalation instead of an
   * exchange. `mcpTokenScopes` therefore intersects: a key holding `mcp:use`
   * alone still mints a token holding `mcp:use` alone, which reads the archive
   * over MCP — that is what the scope is for — and is refused the five write
   * tools exactly as the key is refused the write routes.
   *
   * A leaked token still reads no archive directly, whatever it carries — the
   * guard confines a token of this type to the MCP endpoint.
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
    const scopes = mcpTokenScopes(context.scopes);
    const issued = this.tokens.issue(
      {
        sub: context.userId,
        tenantId: context.tenantId,
        scopes,
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
      // What the token actually got. A key holding mcp:use alone hands back
      // ["mcp:use"] — enough to read the archive, and the one place a client
      // can find out it needs archive:write to curate before a write is
      // refused rather than after.
      scopes,
    };
  }
}
