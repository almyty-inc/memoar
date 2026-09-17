import { Inject, Injectable } from "@nestjs/common";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { TenantContext } from "../archive-store.js";
import { DistillationService } from "../distillation.js";
import { parseToolArguments } from "./arguments.js";
import { ExportProjectMemoryDto, PROJECT_MEMORY_FORMATS } from "./project-memory-tools.dto.js";
import { toolNames, type McpToolGroup } from "./tool-group.js";

const DEFAULT_MAX_CHARS = 20_000;

/**
 * The distilled project memory for a workspace, as an agent would paste it.
 *
 * This is the one distillation capability on MCP. Running distillation spends
 * the tenant's money against a BYOK provider under a monthly budget, and its
 * settings hold a sealed API key; both stay off the agent surface. Rendering
 * notes that have already been distilled reads `listSessions` and
 * `listAnnotations` and writes nothing, and it is precisely the thing an agent
 * starting work in a repository wants: what was already decided here.
 */
export const PROJECT_MEMORY_TOOLS: readonly Tool[] = [
  {
    name: "export_project_memory",
    description: "Render the distilled notes for one workspace as CLAUDE.md- or AGENTS.md-style markdown, each note cited to its source session and turn span. Reads existing notes; it does not run distillation.",
    inputSchema: {
      type: "object",
      required: ["workspace"],
      properties: {
        workspace: { type: "string", maxLength: 4_096, description: "Exact workspace path, as list_sessions reports it." },
        format: { enum: [...PROJECT_MEMORY_FORMATS], description: "Heading dialect, default agents." },
        maxChars: { type: "integer", minimum: 200, maximum: 200_000, description: `Markdown budget, default ${DEFAULT_MAX_CHARS}.` },
      },
    },
  },
] as const;

const PROJECT_MEMORY_TOOL_NAMES = toolNames(PROJECT_MEMORY_TOOLS);

@Injectable()
export class McpProjectMemoryTools implements McpToolGroup {
  readonly tools = PROJECT_MEMORY_TOOLS;

  constructor(@Inject(DistillationService) private readonly distillation: DistillationService) {}

  handles(name: string): boolean {
    return PROJECT_MEMORY_TOOL_NAMES.has(name);
  }

  async call(context: TenantContext, _name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = parseToolArguments(ExportProjectMemoryDto, args);
    const maxChars = request.maxChars ?? DEFAULT_MAX_CHARS;
    const exported = await this.distillation.exportProjectMemory(context, request.workspace, request.format ?? "agents");
    const markdown = typeof exported.markdown === "string" ? exported.markdown : "";
    return {
      workspace: exported.workspace,
      format: exported.format,
      noteCount: exported.noteCount,
      markdown: markdown.slice(0, maxChars),
      truncated: markdown.length > maxChars,
    };
  }
}
