import { createParamDecorator, ExecutionContext, SetMetadata, UnauthorizedException } from "@nestjs/common";

import type { TenantContext } from "../archive-store.js";
import type { RequestLike } from "./types.js";

export const PUBLIC_ROUTE = "memoar:public";
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE, true);
export const REQUIRED_SCOPES = "memoar:required-scopes";
export const RequireScopes = (...scopes: string[]): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_SCOPES, scopes);
export const Tenant = createParamDecorator((_data: unknown, context: ExecutionContext): TenantContext => {
  const request = context.switchToHttp().getRequest<RequestLike>();
  if (!request.tenantContext) throw new UnauthorizedException("Missing tenant context");
  return request.tenantContext;
});
