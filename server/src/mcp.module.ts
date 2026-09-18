import { Module } from "@nestjs/common";
import { AnnotationsModule } from "./annotations/annotations.module.js";
import { AuthModule } from "./auth.module.js";
import { CollectionsModule } from "./collections/collections.module.js";
import { DistillationModule } from "./distillation.module.js";
import { MachinesModule } from "./machines.module.js";
import { McpController, McpHandshakeController, McpRateLimiter, McpService } from "./mcp.js";
import { McpStatusController } from "./mcp/status.controller.js";
import { McpAnnotationTools } from "./mcp/annotation-tools.js";
import { McpArchiveTools } from "./mcp/archive-tools.js";
import { McpCollectionTools } from "./mcp/collection-tools.js";
import { McpCoreTools } from "./mcp/core-tools.js";
import { McpMemoryTools } from "./mcp/memory-tools.js";
import { McpProjectMemoryTools } from "./mcp/project-memory-tools.js";
import { McpToolRegistry } from "./mcp/registry.js";
import { McpSharingTools } from "./mcp/sharing-tools.js";
import { MemoryModule } from "./memory/memory.module.js";
import { SearchModule } from "./search.module.js";
import { SessionsModule } from "./sessions.module.js";
import { SharingModule } from "./sharing/sharing.module.js";
import { TeamsModule } from "./teams.module.js";

@Module({
  // Every tool reaches data through one of these modules' exported services, so
  // tenant scoping, team-membership checks and redaction projection are the
  // ones the HTTP surface already has rather than a second implementation.
  //
  // AuthModule for TokenService: the handshake mints the short-lived token.
  // SharingModule and DistillationModule are imported for their read paths
  // only; what MCP deliberately does not expose from them is in docs/mcp.md.
  imports: [
    AuthModule, SearchModule, SessionsModule, MachinesModule, CollectionsModule,
    AnnotationsModule, MemoryModule, SharingModule, DistillationModule, TeamsModule,
  ],
  controllers: [McpController, McpHandshakeController, McpStatusController],
  providers: [
    { provide: McpRateLimiter, useFactory: () => new McpRateLimiter() },
    McpCoreTools,
    McpArchiveTools,
    McpAnnotationTools,
    McpCollectionTools,
    McpSharingTools,
    McpProjectMemoryTools,
    McpMemoryTools,
    McpToolRegistry,
    McpService,
  ],
})
export class McpModule {}
