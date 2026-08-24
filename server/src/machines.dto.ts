import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class RegisterMachineDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  platform!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentVersion?: string;
}

export class UpdateMachineDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  /** Reported by the agent on every sync so version drift is visible server-side. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentVersion?: string;

  @IsOptional()
  @IsObject()
  sourceSettings?: Record<string, unknown>;
}

export class AckCommandDto {
  @IsIn(["completed", "failed"])
  status!: "completed" | "failed";

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  error?: string;
}
