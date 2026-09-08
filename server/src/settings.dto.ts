import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from "class-validator";

export class RedactionSettingsDto {
  @IsOptional()
  @IsBoolean()
  secretScan?: boolean;

  @IsOptional()
  @IsBoolean()
  pathScan?: boolean;

  @IsOptional()
  @IsBoolean()
  emailScan?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  customPatterns?: string[];
}

export class RetentionSettingsDto {
  @IsOptional()
  @IsIn(["indefinite", "days"])
  policy?: "indefinite" | "days";

  @IsOptional()
  @IsInt()
  @Min(1)
  days?: number;

  @IsOptional()
  @IsBoolean()
  exemptCollected?: boolean;
}

export class UpdateSettingsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => RedactionSettingsDto)
  redaction?: RedactionSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => RetentionSettingsDto)
  retention?: RetentionSettingsDto;
}

export class UpdateDistillationSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(["none", "anthropic"])
  provider?: "none" | "anthropic";

  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string | null;

  /**
   * The account's own provider key.
   *
   * Three states, and they are deliberately not two: absent leaves the stored
   * credential exactly as it was, `null` clears it, and a string replaces it.
   * Collapsing absent and null would mean every settings update that did not
   * resend the key silently deleted it.
   *
   * `ValidateIf` rather than `IsOptional`, because `IsOptional` skips
   * validation for null as well as undefined and would make the two the same
   * again at the one place the difference matters.
   */
  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @IsString()
  @MinLength(8)
  @MaxLength(500)
  apiKey?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyBudgetCents?: number;
}
