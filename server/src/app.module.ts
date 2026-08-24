import { Module } from "@nestjs/common";
import { AnnotationsModule } from "./annotations/annotations.module.js";
import { AuthModule } from "./auth.module.js";
import { CollectionsModule } from "./collections/collections.module.js";
import { ConvertModule } from "./convert.module.js";
import { DEMO_CONTEXT } from "./demo-data.js";
import { DistillationModule } from "./distillation.module.js";
import { HealthController } from "./health.controller.js";
import { InfrastructureModule } from "./infrastructure.module.js";
import { IngestModule } from "./ingest.module.js";
import { MachinesModule } from "./machines.module.js";
import { McpModule } from "./mcp.module.js";
import { OpenApiController } from "./openapi.js";
import { SearchModule } from "./search.module.js";
import { SessionsModule } from "./sessions.module.js";
import { SettingsModule } from "./settings.module.js";
import { SharingModule } from "./sharing/sharing.module.js";
import { TeamsModule } from "./teams.module.js";

/**
 * Composition root. Domain behavior lives in the imported modules; this file
 * only wires them together plus the two infrastructure-level endpoints.
 */
@Module({
  imports: [
    InfrastructureModule,
    AuthModule,
    SessionsModule,
    SearchModule,
    AnnotationsModule,
    CollectionsModule,
    SharingModule,
    SettingsModule,
    TeamsModule,
    MachinesModule,
    IngestModule,
    ConvertModule,
    McpModule,
    DistillationModule,
  ],
  controllers: [HealthController, OpenApiController],
})
export class AppModule {}

export { HealthController };
export { DEMO_CONTEXT };
