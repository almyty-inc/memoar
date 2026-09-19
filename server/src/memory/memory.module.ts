import { Module } from "@nestjs/common";
import { MemoryConversionService } from "./memory-conversion.service.js";
import { MemoryController } from "./memory.controller.js";
import { MemoryService } from "./memory.service.js";

@Module({
  controllers: [MemoryController],
  providers: [MemoryService, MemoryConversionService],
  exports: [MemoryService, MemoryConversionService],
})
export class MemoryModule {}
