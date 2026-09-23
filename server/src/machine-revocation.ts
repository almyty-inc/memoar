import { Controller, Delete, HttpCode, Inject, Injectable, NotFoundException, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import type { MachineStore, TenantContext } from "./archive-store.js";
import { Tenant } from "./auth.js";
import { CredentialsService } from "./auth/credentials.service.js";
import type { RequestLike } from "./auth/types.js";
import { ARCHIVE_STORE } from "./tokens.js";

/**
 * Taking a machine's credentials away.
 *
 * Every machine token was written to `auth_identities` and re-checked there on
 * each request, but nothing ever set `revokedAt`: a leaked token was good for
 * its full hour, and the only lever an operator had was deleting the machine
 * row by hand. These are the two levers, owned here rather than by
 * MachinesService so enrolment and revocation can each be read alone.
 *
 * Both answer a missing machine and another tenant's machine with the same
 * 404, as `getMachine` already does for PATCH: the answer must not say whether
 * an id exists in somebody else's archive.
 *
 * Both are priced machines:write by the guard's inference for writes under
 * `/machines`, and `machine-revocation.test.ts` pins it. A machine token cannot
 * reach either: it is confined to capture and its own command channel.
 */
@Injectable()
export class MachineRevocationService {
  constructor(
    @Inject(ARCHIVE_STORE) private readonly store: MachineStore,
    @Inject(CredentialsService) private readonly credentials: CredentialsService,
  ) {}

  /**
   * Revokes every live token for the machine and keeps the machine, for a
   * token that has leaked. The agent mints a new one at the start of its next
   * sync cycle with the account credential it already holds.
   */
  async revokeTokens(context: TenantContext, machineId: string): Promise<{ revoked: number }> {
    await this.requireMachine(context, machineId);
    return { revoked: await this.credentials.revokeMachineTokens(context, machineId) };
  }

  /**
   * Deregisters the machine: its tokens first, then the machine itself.
   *
   * Retired rather than deleted, because the archive names the machine
   * everywhere without a foreign key to follow (see the MachineRetirement
   * migration). A retired machine cannot mint a token, and any token it still
   * holds is refused because `authenticateBearer` needs a live machine too.
   */
  async deregister(context: TenantContext, machineId: string): Promise<void> {
    await this.requireMachine(context, machineId);
    await this.credentials.revokeMachineTokens(context, machineId);
    if (!await this.store.retireMachine(context, machineId)) throw new NotFoundException("Machine not found");
  }

  /**
   * How a held-open command stream learns its token was revoked, or nothing
   * for a caller that is not a machine token.
   */
  streamLiveness(context: TenantContext, request: RequestLike): (() => Promise<boolean>) | undefined {
    const header = request.headers.authorization;
    const authorization = Array.isArray(header) ? header[0] : header;
    if (context.authType !== "machine" || !authorization?.startsWith("Bearer ")) return undefined;
    const token = authorization.slice(7);
    return async () => !await this.credentials.machineTokenRevoked(token);
  }

  private async requireMachine(context: TenantContext, machineId: string): Promise<void> {
    if (!await this.store.getMachine(context, machineId)) throw new NotFoundException("Machine not found");
  }
}

@Controller("machines")
export class MachineRevocationController {
  constructor(private readonly revocation: MachineRevocationService) {}

  @Delete(":machineId")
  @HttpCode(204)
  deregister(@Tenant() context: TenantContext, @Param("machineId", ParseUUIDPipe) machineId: string): Promise<void> {
    return this.revocation.deregister(context, machineId);
  }

  @Post(":machineId/tokens/revoke")
  @HttpCode(200)
  revokeTokens(@Tenant() context: TenantContext, @Param("machineId", ParseUUIDPipe) machineId: string): Promise<{ revoked: number }> {
    return this.revocation.revokeTokens(context, machineId);
  }
}
