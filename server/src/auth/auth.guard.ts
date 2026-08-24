import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";

import { Reflector } from "@nestjs/core";


import { PUBLIC_ROUTE, REQUIRED_SCOPES } from "./decorators.js";

import { AuthService } from "./auth.service.js";
import type { RequestLike } from "./types.js";

function inferredScopes(request: RequestLike): string[] {
  const path = (request.url ?? request.route?.path ?? "").split("?")[0] ?? "";
  const method = request.method?.toUpperCase() ?? "GET";
  if (path.includes("/mcp")) return ["mcp:use"];
  if (path.includes("/ingest")) return ["ingest:write"];
  if (path.includes("/auth/api-keys")) return ["keys:write"];
  if (path.includes("/auth/machine-token") || path.includes("/machines")) return ["machines:write"];
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
    if (!tenantContext && process.env.NODE_ENV !== "production" && authorization === "Bearer memoar-development-token") {
      tenantContext = {
        tenantId: "0191cafe-0000-7000-8000-000000000002",
        userId: "0191cafe-0000-7000-8000-000000000002",
        scopes: ["*"],
        authType: "dev",
      };
    }
    if (!tenantContext && authorization?.startsWith("Bearer ")) tenantContext = await this.auth.authenticateBearer(authorization.slice(7));
    if (!tenantContext && process.env.NODE_ENV !== "production") {
      const tenantHeader = request.headers["x-memoar-tenant"];
      const userHeader = request.headers["x-memoar-user"];
      const tenantId = Array.isArray(tenantHeader) ? tenantHeader[0] : tenantHeader;
      const userId = Array.isArray(userHeader) ? userHeader[0] : userHeader;
      if (tenantId && userId) tenantContext = {
        tenantId, userId, scopes: ["*"], authType: "dev",
      };
    }
    if (!tenantContext) throw new UnauthorizedException("Valid bearer, machine, or API-key credentials are required");
    const requiredScopes = this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES, [handler, controller]) ?? inferredScopes(request);
    if (!tenantContext.scopes.includes("*") && requiredScopes.some((scope) => !tenantContext.scopes.includes(scope))) {
      throw new ForbiddenException(`Missing required scope: ${requiredScopes.join(", ")}`);
    }
    if (tenantContext.authType === "machine") {
      const path = (request.url ?? "").split("?")[0] ?? "";
      const ownCommandPath = tenantContext.machineId && path.includes(`/machines/${tenantContext.machineId}/commands`);
      if (!path.includes("/ingest") && !ownCommandPath) throw new ForbiddenException("Machine credentials are restricted to their ingest and command channels");
      const bodyMachineId = request.body?.machineId;
      if (typeof bodyMachineId === "string" && bodyMachineId !== tenantContext.machineId) {
        throw new ForbiddenException("Machine credential does not match request machineId");
      }
    }
    request.tenantContext = tenantContext;
    return true;
  }
}
