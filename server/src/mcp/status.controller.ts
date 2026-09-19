import { Controller, Get } from "@nestjs/common";
import { CONTRACT_VERSION } from "../../libs/canonical/src/generated.js";
import { McpToolRegistry } from "./registry.js";

/**
 * Whether this deployment serves MCP, and what it serves.
 *
 * The settings page used to show a green dot and the word "Available" beside
 * the endpoint, unconditionally, next to a URL nothing ever contacted — the
 * third time that pattern had been removed from that file. It could not be
 * gated on anything, because the only route that knew was the handshake, and
 * the handshake authenticates with an API key while a browser holds a session
 * token. This is that missing signal: a session-authenticated read, answered
 * from the same registry that serves the tools, so the badge cannot be right
 * about availability and wrong about what is available.
 */
@Controller("mcp/status")
export class McpStatusController {
  constructor(private readonly registry: McpToolRegistry) {}

  @Get()
  status(): Record<string, unknown> {
    const tools = this.registry.names;
    return {
      // Served by this process, so reaching this route is the answer. It is
      // still a field rather than an implied 200: a client should not have to
      // read a status code to learn a capability.
      available: tools.length > 0,
      contractVersion: CONTRACT_VERSION,
      tools,
    };
  }
}
