import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";

/** The two instruction-file dialects the distillation exporter renders. */
export const PROJECT_MEMORY_FORMATS = ["claude", "agents"] as const;
export type ProjectMemoryFormat = (typeof PROJECT_MEMORY_FORMATS)[number];

/** Arguments for `export_project_memory`. */
export class ExportProjectMemoryDto {
  /** Exact workspace path, as `list_sessions` and `list_memory_documents` report it. */
  @IsString()
  @MinLength(1)
  @MaxLength(4_096)
  workspace!: string;

  @IsOptional()
  @IsIn(PROJECT_MEMORY_FORMATS)
  format?: ProjectMemoryFormat;

  /**
   * How much rendered markdown to return.
   *
   * The HTTP route returns every distilled note for the workspace with no
   * bound at all, which is fine for a browser downloading a file and is not
   * fine for a tool result an agent pays for in context.
   */
  @IsOptional()
  @IsInt()
  @Min(200)
  @Max(200_000)
  maxChars?: number;
}
