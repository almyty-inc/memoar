import { IsOptional, IsUUID } from "class-validator";

/**
 * Enrolling a tenant, or one of its machines, into a team's shared archive.
 *
 * `machineId` absent means every machine of the tenant, including ones added
 * later — the broadest consent this API can express, so it is the one the caller
 * has to leave the field out to get, rather than the one a typo produces.
 */
export class CreateTeamOptinDto {
  @IsOptional()
  @IsUUID()
  machineId?: string;
}
