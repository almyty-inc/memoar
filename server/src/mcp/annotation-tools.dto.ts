import { IsIn, IsInt, IsObject, IsOptional, IsUUID, Max, Min } from "class-validator";
import type { AnnotationKind } from "../../libs/canonical/src/generated.js";

/**
 * The annotation kinds an agent may write.
 *
 * `redaction_mask` is not here on purpose: those annotations are the input to
 * `completeReview`, which copies them into the review record that gates share
 * links and visibility widening. An agent that could write them would be
 * authoring the evidence of a human review it did not perform.
 *
 * `collection` is not here either; collection membership has its own tools,
 * which go through `CollectionService` and its team-membership check, rather
 * than an annotation that nothing validates.
 */
export const MCP_ANNOTATION_KINDS: readonly AnnotationKind[] = ["tag", "pin", "note", "summary"];

/** The largest annotation body a tool will write, as serialized JSON. */
export const MAX_ANNOTATION_VALUE_CHARS = 8_000;

/** Arguments for `list_annotations`. */
export class ListAnnotationsDto {
  /** Omit to list every annotation in the account, newest store order first. */
  @IsOptional()
  @IsUUID()
  sessionId?: string;

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

  /** Per-annotation budget for the serialized `value`; larger ones come back as a preview. */
  @IsOptional()
  @IsInt()
  @Min(200)
  @Max(20_000)
  maxValueChars?: number;
}

/** Arguments for `add_annotation`. */
export class AddAnnotationDto {
  @IsUUID()
  sessionId!: string;

  @IsOptional()
  @IsUUID()
  turnId?: string;

  @IsOptional()
  @IsUUID()
  blockId?: string;

  @IsIn(MCP_ANNOTATION_KINDS)
  kind!: AnnotationKind;

  @IsObject()
  value!: Record<string, unknown>;
}
