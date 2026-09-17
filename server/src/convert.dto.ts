import { IsIn, IsString, IsUUID, Matches, MaxLength, MinLength } from "class-validator";

export class RequestConversionDto {
  @IsUUID()
  sessionId!: string;

  /**
   * Free-form by design — an unknown target is served by the injection
   * fallback — but not arbitrary. It is interpolated into the resume command a
   * person is told to run and copied into a machine command payload, so it is
   * held to the shape of a tool name: no whitespace, no quotes, no shell
   * metacharacters, and short enough that the command stays readable.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9._-]*$/u, { message: "target must be a lowercase tool name (letters, digits, dot, dash, underscore)" })
  target!: string;

  @IsIn(["fail", "injection"])
  fallback!: "fail" | "injection";
}

export class MaterializeDto {
  @IsUUID()
  machineId!: string;
}
