import { Module } from "@nestjs/common";
import { DistillationController, DistillationService } from "./distillation.js";

@Module({ controllers: [DistillationController], providers: [DistillationService], exports: [DistillationService] })
export class DistillationModule {}
