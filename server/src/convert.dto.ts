import { IsIn, IsString, IsUUID, MinLength } from "class-validator";

export class RequestConversionDto {
  @IsUUID()
  sessionId!: string;

  /** Free-form: unknown targets are served by the injection fallback. */
  @IsString()
  @MinLength(1)
  target!: string;

  @IsIn(["fail", "injection"])
  fallback!: "fail" | "injection";
}

export class MaterializeDto {
  @IsUUID()
  machineId!: string;
}
