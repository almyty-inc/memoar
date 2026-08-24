import { IsIn, IsObject, IsOptional, IsUUID } from "class-validator";
import type { AnnotationKind } from "../../libs/canonical/src/generated.js";

/** Mirrors AnnotationKind in the canonical model; the ORM conformance test pins the model itself. */
export const ANNOTATION_KINDS: readonly AnnotationKind[] = [
  "tag", "collection", "pin", "note", "summary", "redaction_mask",
];

export class CreateAnnotationDto {
  @IsUUID()
  sessionId!: string;

  @IsOptional()
  @IsUUID()
  turnId?: string;

  @IsOptional()
  @IsUUID()
  blockId?: string;

  @IsIn(ANNOTATION_KINDS)
  kind!: AnnotationKind;

  @IsObject()
  value!: Record<string, unknown>;
}

export class UpdateAnnotationDto {
  @IsObject()
  value!: Record<string, unknown>;
}
