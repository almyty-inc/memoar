import { Module } from "@nestjs/common";
import { CollectionController } from "./collections.controller.js";
import { CollectionService } from "./collections.service.js";

@Module({
  controllers: [CollectionController],
  providers: [CollectionService],
  exports: [CollectionService],
})
export class CollectionsModule {}
