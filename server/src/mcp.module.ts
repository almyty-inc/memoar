import { Module } from "@nestjs/common";
import { AnnotationsModule } from "./annotations/annotations.module.js";
import { AuthModule } from "./auth.module.js";
import { CollectionsModule } from "./collections/collections.module.js";
import { McpController, McpHandshakeController, McpRateLimiter, McpService } from "./mcp.js";
import { McpMemoryTools } from "./mcp/memory-tools.js";
import { MemoryModule } from "./memory/memory.module.js";
import { SearchModule } from "./search.module.js";
import { SessionsModule } from "./sessions.module.js";

@Module({
  // AuthModule for TokenService: the handshake mints the short-lived token.
  // MemoryModule for MemoryService: the memory-document tools read through the
  // same service the HTTP surface uses, tenant scoping and all.
  imports: [AuthModule, SearchModule, SessionsModule, CollectionsModule, AnnotationsModule, MemoryModule],
  controllers: [McpController, McpHandshakeController],
  providers: [{ provide: McpRateLimiter, useFactory: () => new McpRateLimiter() }, McpMemoryTools, McpService],
})
export class McpModule {}
