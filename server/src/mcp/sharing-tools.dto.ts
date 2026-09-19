import { IsInt, IsOptional, Max, Min } from "class-validator";

/** Arguments for `list_share_links` and `list_transfers`: a page bound and nothing else. */
export class ListSharingDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset?: number;
}
