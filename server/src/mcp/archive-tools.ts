import { Inject, Injectable } from "@nestjs/common";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { TenantContext } from "../archive-store.js";
import { MachinesService } from "../machines.js";
import { SessionsService } from "../sessions.js";
import { parseToolArguments } from "./arguments.js";
import { ListMachinesDto, ListSessionsDto } from "./archive-tools.dto.js";
import { pageSize, toolNames, type McpToolGroup } from "./tool-group.js";

const DEFAULT_SESSION_LIMIT = 25;
const DEFAULT_MACHINE_LIMIT = 50;

/**
 * Browsing, as opposed to searching.
 *
 * `search_sessions` needs a query, so an agent asked "what did I work on in
 * this repo last week" had to invent one and hope the ranking agreed. The web
 * app never had that problem: its timeline is `GET /sessions`, which filters
 * and pages without a query at all. `list_machines` is here because three tools
 * — this one, `list_memory_documents` and the HTTP surface — take a `machineId`
 * and nothing over MCP could tell an agent what the machine ids were.
 */
export const ARCHIVE_TOOLS: readonly Tool[] = [
  {
    name: "list_sessions",
    description: "Browse archived sessions newest-first without a search query, filtered by agent, workspace, machine, model or date range. Use this to enumerate; use search_sessions to rank by relevance.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, description: `Page size, default ${DEFAULT_SESSION_LIMIT}.` },
        cursor: { type: "string", maxLength: 200, description: "nextCursor from a previous call." },
        agent: { type: "string", maxLength: 100, description: "Capture tool, e.g. claude-code or codex." },
        workspace: { type: "string", maxLength: 4_096, description: "Exact workspace path." },
        machineId: { type: "string", description: "Machine id from list_machines." },
        model: { type: "string", maxLength: 200 },
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
      },
    },
  },
  {
    name: "list_machines",
    description: "List the machines that have captured sessions for this account, with their platform, last-seen time and per-source session counts. Use it to resolve a machineId for list_sessions or list_memory_documents.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200, description: `Default ${DEFAULT_MACHINE_LIMIT}.` } },
    },
  },
] as const;

const ARCHIVE_TOOL_NAMES = toolNames(ARCHIVE_TOOLS);

@Injectable()
export class McpArchiveTools implements McpToolGroup {
  readonly tools = ARCHIVE_TOOLS;

  constructor(
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(MachinesService) private readonly machines: MachinesService,
  ) {}

  handles(name: string): boolean {
    return ARCHIVE_TOOL_NAMES.has(name);
  }

  async call(context: TenantContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name === "list_sessions") return this.listSessions(context, args);
    return this.listMachines(context, args);
  }

  private async listSessions(context: TenantContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = parseToolArguments(ListSessionsDto, args);
    // The service takes the query string the HTTP route receives, so the tool
    // reaches the archive through exactly the path the web app does.
    return this.sessions.list(context, {
      limit: String(request.limit ?? DEFAULT_SESSION_LIMIT),
      ...(request.cursor ? { cursor: request.cursor } : {}),
      ...(request.agent ? { agent: request.agent } : {}),
      ...(request.workspace ? { workspace: request.workspace } : {}),
      ...(request.machineId ? { machineId: request.machineId } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.from ? { from: request.from } : {}),
      ...(request.to ? { to: request.to } : {}),
    });
  }

  private async listMachines(context: TenantContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = parseToolArguments(ListMachinesDto, args);
    const limit = pageSize(request.limit, DEFAULT_MACHINE_LIMIT, 200);
    const { items } = await this.machines.list(context);
    return { items: items.slice(0, limit), total: items.length, limit };
  }
}
