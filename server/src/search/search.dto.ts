import { IsIn, IsInt, IsOptional, IsString, Max, MinLength, Min } from "class-validator";

/**
 * Mirrors PackRequest in contracts/openapi.yaml. The bounds are the contract's,
 * not defensive guesses: without them an absent query and unparsable limits
 * reached the SQL layer directly, where Postgres rejected NaN as a bigint and
 * the caller saw a 500 for what is plainly a malformed request.
 */
export class BuildPackDto {
  @IsString()
  @MinLength(1)
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
