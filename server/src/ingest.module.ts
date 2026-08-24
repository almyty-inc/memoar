import { Module } from "@nestjs/common";
import { IngestController, IngestService } from "./ingest.js";

@Module({ controllers: [IngestController], providers: [IngestService], exports: [IngestService] })
export class IngestModule {}
