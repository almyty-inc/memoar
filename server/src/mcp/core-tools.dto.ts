import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from "class-validator";

/** The three retrieval strategies the search service realizes. */
export const SEARCH_MODES = ["hybrid", "lexical", "semantic"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/**
 * Arguments for `search_sessions`.
 *
 * The filters were documented in `skill/SKILL.md` — "relevant project, agent,
 * machine, or date filters" — and were never implemented: the handler read
 * `query`, `mode` and `limit` and passed an empty filter object. HTTP `/search`
 * has had them all along, so an agent was told to use something the tool did
 * not have. `machineId` is deliberately absent: `SearchFilters` has no such
 * field, and `list_sessions` is the tool that filters by machine.
 */
export class SearchSessionsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1_000)
  query!: string;

  @IsOptional()
  @IsIn(SEARCH_MODES)
  mode?: SearchMode;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

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
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  /** A team the caller belongs to. Present, the tool reads that team's shared archive instead of the caller's own. */
  @IsOptional()
  @IsUUID()
  teamId?: string;
}

/** Arguments for `get_excerpt`. */
export class GetExcerptDto {
  @IsUUID()
  sessionId!: string;

  @IsInt()
  @Min(0)
  @Max(1_000_000)
  turnStart!: number;

  @IsInt()
  @Min(0)
  @Max(1_000_000)
  turnEnd!: number;

  @IsOptional()
  @IsInt()
  @Min(200)
  @Max(20_000)
  maxChars?: number;

  /** A team the caller belongs to. Present, the tool reads that team's shared archive instead of the caller's own. */
  @IsOptional()
  @IsUUID()
  teamId?: string;
}

/** Arguments for `get_session`. */
export class GetSessionDto {
  @IsUUID()
  sessionId!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  chunkSize?: number;

  /** A team the caller belongs to. Present, the tool reads that team's shared archive instead of the caller's own. */
  @IsOptional()
  @IsUUID()
  teamId?: string;
}

/** Arguments for `list_collections`. */
export class ListCollectionsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** Arguments for `get_memory`. */
export class GetMemoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1_000)
  topic!: string;

  @IsOptional()
  @IsInt()
  @Min(64)
  @Max(8_000)
  maxTokens?: number;
}

/** Arguments for `save_note`. */
export class SaveNoteDto {
  @IsUUID()
  sessionId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  markdown!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  topic?: string;
}
