import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { TenantContext } from "../archive-store.js";

/**
 * One family of MCP tools.
 *
 * `mcp.ts` used to hold every tool and every handler in one `callTool` chain,
 * which is why it was already at its size limit with nine tools in it. A group
 * owns its own schemas, its own DTOs and its own service dependencies; the
 * registry only asks which group answers to a name.
 */
export interface McpToolGroup {
  readonly tools: readonly Tool[];
  handles(name: string): boolean;
  call(context: TenantContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function toolNames(tools: readonly Tool[]): ReadonlySet<string> {
  return new Set(tools.map((tool) => tool.name));
}

/**
 * Clamps a caller-supplied page size.
 *
 * Every tool bounds what it returns, because an agent calling one spends its
 * own context on the answer. The bound is stated in the DTO as well, so a
 * caller that asks for more is told rather than quietly given less; this is the
 * default when nothing was asked for.
 */
export function pageSize(requested: number | undefined, fallback: number, maximum: number): number {
  return Math.min(maximum, requested ?? fallback);
}
