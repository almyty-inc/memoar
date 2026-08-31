import { IsArray, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";
import type { MemoryScope } from "../../libs/canonical/src/generated.js";

export const MEMORY_SCOPES: readonly MemoryScope[] = ["global", "project"];

/**
 * One reading of one memory file.
 *
 * A body typed as an interface is invisible to the validation pipe, so this is
 * a class: every field an agent sends is checked before it reaches the store.
 */
export class CaptureMemoryDto {
  @IsIn(MEMORY_SCOPES)
  scope!: MemoryScope;

  @IsUUID()
  machineId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  workspacePath?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  path!: string;

  @IsArray()
  @IsString({ each: true })
  readers!: string[];

  /**
   * These files are written by hand and stay small; a megabyte is far beyond
   * any of them and keeps one upload from becoming a way to fill the archive.
   */
  @IsString()
  @MaxLength(1_000_000)
  text!: string;

  @IsISO8601()
  capturedAt!: string;
}
