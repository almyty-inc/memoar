import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsDateString, IsInt, IsOptional, IsString, IsUUID, Matches, Min, ValidateNested } from "class-validator";

const SHA256 = /^[0-9a-f]{64}$/;

export class ManifestArtifactDto {
  @Matches(SHA256, { message: "sha256 must be a lowercase hex digest" })
  sha256!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  size?: number;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  sourcePath?: string;

  @IsOptional()
  @IsDateString()
  modifiedAt?: string;
}

export class ManifestDto {
  @IsUUID()
  machineId!: string;

  @IsString()
  batchId!: string;

  @IsArray()
  @ArrayMaxSize(10_000)
  @ValidateNested({ each: true })
  @Type(() => ManifestArtifactDto)
  artifacts!: ManifestArtifactDto[];
}

export class DeltaDto {
  @IsUUID()
  machineId!: string;

  @IsArray()
  @ArrayMaxSize(10_000)
  @Matches(SHA256, { each: true, message: "hashes must be lowercase hex digests" })
  hashes!: string[];
}
