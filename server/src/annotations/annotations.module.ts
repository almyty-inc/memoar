import { Module } from "@nestjs/common";
import { AnnotationController } from "./annotations.controller.js";
import { AnnotationService } from "./annotations.service.js";

@Module({
  controllers: [AnnotationController],
  providers: [AnnotationService],
  exports: [AnnotationService],
})
export class AnnotationsModule {}
