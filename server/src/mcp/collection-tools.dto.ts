import { IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";

/** Arguments for `list_collection_sessions`. */
export class ListCollectionSessionsDto {
  @IsUUID()
  collectionId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset?: number;
}

/** Arguments for `add_session_to_collection` and `remove_session_from_collection`. */
export class CollectionMembershipDto {
  @IsUUID()
  collectionId!: string;

  @IsUUID()
  sessionId!: string;
}
