import { Type } from "class-transformer";
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, MinLength, Min } from "class-validator";

/**
 * Mirrors PackRequest in contracts/openapi.yaml. The bounds are the contract's,
 * not defensive guesses: without them an absent query and unparsable limits
 * reached the SQL layer directly, where Postgres rejected NaN as a bigint and
 * the caller saw a 500 for what is plainly a malformed request.
 */
export class BuildPackDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4_000)
  query!: string;

  @IsInt()
  @Min(64)
  @Max(32_000)
  maxTokens!: number;

  @IsInt()
  @Min(1)
  @Max(100)
  maxEvidence!: number;

  @IsInt()
  @Min(1)
  @Max(50)
  maxSessions!: number;

  @IsInt()
  @Min(80)
  @Max(20_000)
  maxExcerptChars!: number;

  @IsIn(["strict", "mixed"])
  freshnessPolicy!: "strict" | "mixed";

  @IsOptional()
  @IsInt()
  @Min(1)
  staleAfterDays?: number;
}

/**
 * The /search query string, which had none of this.
 *
 * `Number.parseInt("abc")` is NaN and NaN reached `LIMIT $n`; `new Date("yesterday")`
 * is an Invalid Date and that reached the comparison. Both came back as a 500,
 * logged with a stack and fingerprinted as a fault of ours — for a caller who
 * simply mistyped a parameter. This file already said, above, that the same
 * mistake had been fixed for /pack; /search kept it.
 */
export class SearchQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(4_000)
  q?: string;

  @IsOptional()
  @IsIn(["hybrid", "lexical", "semantic"])
  mode?: "hybrid" | "lexical" | "semantic";

  @IsOptional()
  @IsString()
  @MaxLength(200)
  agent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4_096)
  workspace?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  // The query string is text, so the number has to be asked for explicitly:
  // implicit conversion is off globally, on purpose.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
