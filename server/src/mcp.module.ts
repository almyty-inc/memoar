import { Module } from "@nestjs/common";
import { AnnotationsModule } from "./annotations/annotations.module.js";
import { AuthModule } from "./auth.module.js";
import { CollectionsModule } from "./collections/collections.module.js";
import { McpController, McpHandshakeController, McpRateLimiter, McpService } from "./mcp.js";
import { SearchModule } from "./search.module.js";
import { SessionsModule } from "./sessions.module.js";

@Module({
  // AuthModule for TokenService: the handshake mints the short-lived token.
  imports: [AuthModule, SearchModule, SessionsModule, CollectionsModule, AnnotationsModule],
  controllers: [McpController, McpHandshakeController],
  providers: [{ provide: McpRateLimiter, useFactory: () => new McpRateLimiter() }, McpService],
})
export class McpModule {}
