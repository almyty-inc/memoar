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

  /**
   * A stable, opaque, randomly generated id for the agent installation making
   * this call — one per config directory, kept for its lifetime.
   *
   * Sending it makes registering idempotent: the same installation gets the
   * machine it already has instead of a second one. Omitting it registers a new
   * machine every time, as before.
   *
   * The floor on length is not validation of a format — the value is never
   * parsed — it is a refusal to treat something short enough to have been typed
   * or hardcoded as an identity, because a client shipping a constant here
   * would collapse a whole account onto one machine.
   */
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  installationId?: string;
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
