import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Min, ValidateNested } from "class-validator";

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
  @IsInt()
  @Min(0)
  monthlyBudgetCents?: number;
}
