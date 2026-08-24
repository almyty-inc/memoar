import { Module } from "@nestjs/common";
import { RedactionReviewController, ShareConsumeController, SharingController } from "./sharing.controller.js";
import { SharingService } from "./sharing.service.js";

@Module({
  controllers: [SharingController, ShareConsumeController, RedactionReviewController],
  providers: [SharingService],
  exports: [SharingService],
})
export class SharingModule {}
