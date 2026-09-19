import { IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from "class-validator";

/**
 * Arguments for `list_sessions`.
 *
 * Mirrors `SessionFilter` and the query parameters of `GET /sessions`. The
 * bounds are stated here rather than clamped in the handler, which is what the
 * HTTP route does: `positiveInt` silently turns a limit of 5000 into 100, so a
 * caller believes it saw everything. A tool call says so instead.
 */
export class ListSessionsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /** Opaque cursor from a previous page's `nextCursor`. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  cursor?: string;

  /** The capture tool, e.g. `claude-code` or `codex`. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  agent?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4_096)
  workspace?: string;

  @IsOptional()
  @IsUUID()
  machineId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  model?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

/** Arguments for `list_machines`. */
export class ListMachinesDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
