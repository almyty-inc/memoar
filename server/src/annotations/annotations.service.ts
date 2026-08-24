import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Annotation } from "../../libs/canonical/src/generated.js";
import type { AnnotationStore, TenantContext } from "../archive-store.js";
import { ARCHIVE_STORE } from "../tokens.js";
import type { CreateAnnotationDto } from "./annotations.dto.js";

@Injectable()
export class AnnotationService {
  constructor(@Inject(ARCHIVE_STORE) private readonly store: AnnotationStore) {}

  async list(context: TenantContext, sessionId?: string): Promise<{ items: Annotation[] }> {
    return { items: await this.store.listAnnotations(context, sessionId) };
  }

  create(context: TenantContext, input: CreateAnnotationDto): Promise<Annotation> {
    return this.store.createAnnotation(context, input);
  }

  async update(context: TenantContext, id: string, value: Record<string, unknown>): Promise<Annotation> {
    const annotation = await this.store.updateAnnotation(context, id, value);
    if (!annotation) throw new NotFoundException("Annotation not found");
    return annotation;
  }

  async remove(context: TenantContext, id: string): Promise<void> {
    if (!await this.store.deleteAnnotation(context, id)) throw new NotFoundException("Annotation not found");
  }
}
