import { Inject, Injectable } from "@nestjs/common";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { TenantContext } from "../archive-store.js";
import { McpAnnotationTools } from "./annotation-tools.js";
import { McpArchiveTools } from "./archive-tools.js";
import { McpCollectionTools } from "./collection-tools.js";
import { McpCoreTools } from "./core-tools.js";
import { McpMemoryTools } from "./memory-tools.js";
import { McpProjectMemoryTools } from "./project-memory-tools.js";
import { McpSharingTools } from "./sharing-tools.js";
import type { McpToolGroup } from "./tool-group.js";

/**
 * Every tool the MCP server serves, in the order a client should meet them.
 *
 * The list used to be a module-level constant in `mcp.ts` beside a `callTool`
 * chain that knew every service in the application. Adding a tool meant adding
 * a branch and a constructor argument to a file already at its size limit.
 */
@Injectable()
export class McpToolRegistry {
  private readonly groups: readonly McpToolGroup[];

  constructor(
    @Inject(McpCoreTools) core: McpCoreTools,
    @Inject(McpArchiveTools) archive: McpArchiveTools,
    @Inject(McpAnnotationTools) annotations: McpAnnotationTools,
    @Inject(McpCollectionTools) collections: McpCollectionTools,
    @Inject(McpSharingTools) sharing: McpSharingTools,
    @Inject(McpProjectMemoryTools) projectMemory: McpProjectMemoryTools,
    @Inject(McpMemoryTools) memory: McpMemoryTools,
  ) {
    this.groups = [core, archive, annotations, collections, sharing, projectMemory, memory];
  }

  get tools(): Tool[] {
    return this.groups.flatMap((group) => [...group.tools]);
  }

  get names(): string[] {
    return this.tools.map((tool) => tool.name);
  }

  /**
   * Async even though the lookup is synchronous.
   *
   * A tool that refuses its arguments throws out of `parseToolArguments`, and a
   * caller — the MCP request handler, or a test — is awaiting a promise. A
   * synchronous throw from here escapes that `try` and became a 500 rather than
   * the tool error it is.
   */
  async call(context: TenantContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const group = this.groups.find((candidate) => candidate.handles(name));
    if (!group) throw new Error(`unknown_tool:${name}`);
    return group.call(context, name, args);
  }
}
