import { Module } from "@nestjs/common";
import { MemoryController } from "./memory.controller.js";
import { MemoryService } from "./memory.service.js";

@Module({
  controllers: [MemoryController],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
