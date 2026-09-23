import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";

import { Reflector } from "@nestjs/core";


import { developmentAuthEnabled } from "../dev-mode.js";
import { authFailures } from "../metrics/metrics.registry.js";

import { PUBLIC_ROUTE, REQUIRED_SCOPES } from "./decorators.js";

import { AuthService } from "./auth.service.js";
import type { RequestLike } from "./types.js";

/**
 * What a route costs when it does not say so itself.
 *
 * Exported because the MCP tool table is checked against it: every tool must
 * cost what the route it wraps costs, and the only way to assert that without
 * copying this logic into a test is to ask this function.
 */
export function inferredScopes(request: RequestLike): string[] {
  const path = (request.url ?? request.route?.path ?? "").split("?")[0] ?? "";
  const method = request.method?.toUpperCase() ?? "GET";
  if (path.includes("/mcp")) return ["mcp:use"];
  if (path.includes("/ingest")) return ["ingest:write"];
  if (path.includes("/auth/api-keys")) return ["keys:write"];
  if (path.includes("/auth/machine-token")) return ["machines:write"];
  // Reading the machine list is reading the archive's own metadata — which
  // machine captured what — and it was inferred as machines:write along with
  // registering a machine and setting what its laptop captures. The same
  // mistake the /teams branch below documents: a whole path prefix priced by
  // its most dangerous verb. A key that may read sessions may see which
  // machine they came from; minting and configuring machines still may not.
  if (path.includes("/machines")) return method === "GET" ? ["archive:read"] : ["machines:write"];
  // Two reads shaped like writes. `POST /pack` and `POST /distillation/
  // projects/export` take a body and return evidence; neither stores anything,
  // and both were inferred as archive:write purely from the verb. That is not
  // a harmless over-charge: `pack` is the tool this archive exists for, so
  // pricing it as a write is an instruction to hand agents write keys.
  // `POST /memory/conversions` already carries @RequireScopes("archive:read")
  // for exactly this reason; these two had no decorator to correct them.
  if (path.endsWith("/pack") || path.includes("/distillation/projects/export")) return ["archive:read"];
  // Writing under /teams is deciding who may read whose archive: joining a
  // team, leaving one, or putting somebody out of one. It is the same act the
  // invite route already asks sharing:write for, and it matched no branch here,
  // so every other verb on /teams was inferred as archive:write — the scope for
  // writing one's own archive. A key issued to a capture script could not add a
  // member (403, from the decorator) but could remove every one of them.
  // Writing under /teams is deciding who may read whose archive: joining a
  // team, leaving one, or putting somebody out of one. It is the same act the
  // invite route already asks sharing:write for, and it matched no branch here,
  // so every other verb on /teams was inferred as archive:write — the scope for
  // writing one's own archive. A key issued to a capture script could not add a
  // member (403, from the decorator) but could remove every one of them.
  if (path.includes("/teams")) return method === "GET" ? ["archive:read"] : ["sharing:write"];
  if (path.includes("/sharing")) return method === "GET" ? ["archive:read"] : ["sharing:write"];
  return method === "GET" ? ["archive:read"] : ["archive:write"];
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService, private readonly reflector: Reflector) {}

  async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const request = executionContext.switchToHttp().getRequest<RequestLike>();
    const handler = executionContext.getHandler();
    const controller = executionContext.getClass();
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [handler, controller]);
    if (isPublic) return true;
    const apiKeyHeader = request.headers["x-memoar-key"];
    const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
    const authorizationHeader = request.headers.authorization;
    const authorization = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
    let tenantContext = apiKey ? await this.auth.authenticateApiKey(apiKey) : null;
    if (!tenantContext && developmentAuthEnabled() && authorization === "Bearer memoar-development-token") {
      tenantContext = {
        tenantId: "0191cafe-0000-7000-8000-000000000002",
        userId: "0191cafe-0000-7000-8000-000000000002",
        scopes: ["*"],
        authType: "dev",
      };
    }
    if (!tenantContext && authorization?.startsWith("Bearer ")) tenantContext = await this.auth.authenticateBearer(authorization.slice(7));
    // Headers that name their own tenant: a development convenience, and an
    // impersonation of any tenant on earth if it were ever reachable.
    if (!tenantContext && developmentAuthEnabled()) {
      const tenantHeader = request.headers["x-memoar-tenant"];
      const userHeader = request.headers["x-memoar-user"];
      const tenantId = Array.isArray(tenantHeader) ? tenantHeader[0] : tenantHeader;
      const userId = Array.isArray(userHeader) ? userHeader[0] : userHeader;
      if (tenantId && userId) tenantContext = {
        tenantId, userId, scopes: ["*"], authType: "dev",
      };
    }
    if (!tenantContext) {
      // Counted by why, not by who: a climb in "unauthenticated" is someone
      // knocking, a climb in "missing_scope" is usually a client of ours that
      // has been given the wrong token.
      authFailures.inc({ reason: "unauthenticated" });
      throw new UnauthorizedException("Valid bearer, machine, or API-key credentials are required");
    }
    const requiredScopes = this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES, [handler, controller]) ?? inferredScopes(request);
    if (!tenantContext.scopes.includes("*") && requiredScopes.some((scope) => !tenantContext.scopes.includes(scope))) {
      authFailures.inc({ reason: "missing_scope" });
      throw new ForbiddenException(`Missing required scope: ${requiredScopes.join(", ")}`);
    }
    // A handshake token now carries the archive scopes of the key it came
    // from, so that each MCP tool can be gated the way its route is. Those
    // scopes are for MCP and for nothing else: the token is handed to a
    // third-party client through an environment variable, and `docs/mcp.md`
    // has always promised it "opens MCP only". Without this line that promise
    // would have quietly become untrue for every key holding archive:read.
    if (tenantContext.authType === "mcp" && !((request.url ?? "").split("?")[0] ?? "").includes("/mcp")) {
      authFailures.inc({ reason: "mcp_restricted" });
      throw new ForbiddenException("MCP session tokens are restricted to the MCP endpoint");
    }
    if (tenantContext.authType === "machine") {
      const path = (request.url ?? "").split("?")[0] ?? "";
      const ownCommandPath = tenantContext.machineId && path.includes(`/machines/${tenantContext.machineId}/commands`);
      // What a machine may write: transcripts, and the memory files the agents
      // on it read. Reading the archive is not on the list — and does not need
      // to be excluded here, because it asks for a scope a machine has not got.
      const capturePath = path.includes("/ingest") || path.includes("/memory");
      if (!capturePath && !ownCommandPath) {
        authFailures.inc({ reason: "machine_restricted" });
        throw new ForbiddenException("Machine credentials are restricted to their capture and command channels");
      }
      const bodyMachineId = request.body?.machineId;
      if (typeof bodyMachineId === "string" && bodyMachineId !== tenantContext.machineId) {
        authFailures.inc({ reason: "machine_mismatch" });
        throw new ForbiddenException("Machine credential does not match request machineId");
      }
    }
    request.tenantContext = tenantContext;
    return true;
  }
}
