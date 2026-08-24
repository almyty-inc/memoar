import { Type } from "class-transformer";
import { IsDateString, IsEmail, IsIn, IsObject, IsOptional, IsUUID, ValidateNested } from "class-validator";
import type { Visibility } from "../../libs/canonical/src/generated.js";

export class CreateShareLinkDto {
  @IsUUID()
  sessionId!: string;

  @IsIn(["viewer", "importer"])
  permission!: "viewer" | "importer";

  @IsUUID()
  redactionReviewId!: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;
}

export class RequestTransferDto {
  @IsUUID()
  sessionId!: string;

  @IsEmail()
  recipientEmail!: string;

  @IsUUID()
  redactionReviewId!: string;
}

export class VisibilityDto {
  @IsIn(["private", "team", "org", "link"])
  scope!: Visibility["scope"];

  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsOptional()
  @IsUUID()
  orgId?: string;
}

export class UpdateVisibilityDto {
  @IsObject()
  @ValidateNested()
  @Type(() => VisibilityDto)
  visibility!: VisibilityDto;

  @IsOptional()
  @IsUUID()
  redactionReviewId?: string;
}
