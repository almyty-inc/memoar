import { Inject, Injectable } from "@nestjs/common";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { TenantContext } from "../archive-store.js";
import { requireReviewed } from "../memory/memory-redaction.js";
import { MEMORY_SCOPES } from "../memory/memory.dto.js";
import { MemoryService } from "../memory/memory.service.js";
import { parseToolArguments } from "./arguments.js";
import { GetMemoryDocumentDto, ListMemoryDocumentsDto } from "./memory-tools.dto.js";
import { toolNames, type McpToolGroup } from "./tool-group.js";

const DEFAULT_LIMIT = 25;
const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_MAX_REVISIONS = 10;

/**
 * The instruction files, over MCP.
 *
 * `get_memory` packs sessions for a topic and is a different thing entirely;
 * these two read the captured CLAUDE.md / AGENTS.md / GEMINI.md / .goosehints
 * files themselves, which until now were reachable only over HTTP and in the
 * web app. The descriptions say so, because a name alone has misled clients.
 */
export const MEMORY_TOOLS: readonly Tool[] = [
  {
    name: "list_memory_documents",
    description: "List the captured instruction files (CLAUDE.md, AGENTS.md, GEMINI.md, .goosehints) the agents on this account read. Filter by workspace or by filename pattern. Unrelated to get_memory, which packs sessions.",
    inputSchema: {
      type: "object",
      properties: {
        machineId: { type: "string", description: "Only files captured on this machine." },
        scope: { enum: [...MEMORY_SCOPES], description: "global for a user-wide file, project for one inside a workspace." },
        workspacePath: { type: "string", maxLength: 4096, description: "Exact workspace the file belongs to." },
        pathPattern: { type: "string", maxLength: 200, description: "Glob over the file name or full path, e.g. CLAUDE.md or /workspace/*/AGENTS.md." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: `Page size, default ${DEFAULT_LIMIT}.` },
        offset: { type: "integer", minimum: 0, maximum: 10_000, description: "Page offset, default 0." },
      },
    },
  },
  {
    name: "get_memory_document",
    description: "Read one captured instruction file: its current text plus the history of how it changed. Take the documentId from list_memory_documents. A file the secret scanner flagged is refused until a person reviews it in the web app.",
    inputSchema: {
      type: "object",
      required: ["documentId"],
      properties: {
        documentId: { type: "string", description: "Document id from list_memory_documents." },
        maxChars: { type: "integer", minimum: 200, maximum: 200_000, description: `Characters of current text to return, default ${DEFAULT_MAX_CHARS}.` },
        maxRevisions: { type: "integer", minimum: 1, maximum: 50, description: `Revisions of history to return, newest first, default ${DEFAULT_MAX_REVISIONS}.` },
      },
    },
  },
] as const;

const MEMORY_TOOL_NAMES = toolNames(MEMORY_TOOLS);

@Injectable()
export class McpMemoryTools implements McpToolGroup {
  readonly tools = MEMORY_TOOLS;

  constructor(@Inject(MemoryService) private readonly memory: MemoryService) {}

  handles(name: string): boolean {
    return MEMORY_TOOL_NAMES.has(name);
  }

  async call(context: TenantContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name === "list_memory_documents") return this.list(context, args);
    return this.get(context, args);
  }

  private async list(context: TenantContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = parseToolArguments(ListMemoryDocumentsDto, args);
    const page = await this.memory.search(
      context,
      {
        ...(query.machineId ? { machineId: query.machineId } : {}),
        ...(query.scope ? { scope: query.scope } : {}),
        ...(query.workspacePath ? { workspacePath: query.workspacePath } : {}),
        ...(query.pathPattern ? { pathPattern: query.pathPattern } : {}),
      },
      { limit: query.limit ?? DEFAULT_LIMIT, offset: query.offset ?? 0 },
    );
    return { ...page };
  }

  private async get(context: TenantContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = parseToolArguments(GetMemoryDocumentDto, args);
    // The service throws when the document belongs to another tenant or does
    // not exist; both are the same answer, and neither is ours to soften.
    const { document, revisions } = await this.memory.get(context, request.documentId);
    /*
      The gate, on the text rather than on the listing.

      An MCP client is not a person reading their own archive: it packs what it
      is given into a model's context and passes it on, and nothing in that
      path ever re-reads the file. That is precisely the case the owner argued
      about — "unlike a transcript nobody re-reads them before sharing" — so a
      memory file the scanner flagged does not answer here until somebody has
      looked at it. Listing still works, because an agent that cannot discover
      the document cannot tell its human which file needs reviewing.
    */
    requireReviewed(document);
    const maxChars = request.maxChars ?? DEFAULT_MAX_CHARS;
    // The current text is the revision the document points at, not the newest
    // one. A file edited and then reverted reuses the revision already recorded
    // for that text — deliberately, because it is the same text — and that row
    // keeps its original `capturedAt`. So after A, then B, then back to A, the
    // history reads [B, A] newest-first while the document says A, and taking
    // the head returned B's text beside A's hash: two different versions
    // presented as one.
    const current = revisions.find((revision) => revision.contentHash === document.contentHash)
      ?? revisions.at(0)
      ?? null;
    const text = current?.text ?? "";
    return {
      document,
      content: {
        text: text.slice(0, maxChars),
        truncated: text.length > maxChars,
        contentHash: document.contentHash,
        capturedAt: document.capturedAt,
      },
      // The history is metadata only: a document with fifty revisions of a long
      // file would otherwise answer one call with every version of it.
      revisions: revisions.slice(0, request.maxRevisions ?? DEFAULT_MAX_REVISIONS).map((revision) => ({
        id: revision.id,
        contentHash: revision.contentHash,
        size: revision.size,
        capturedAt: revision.capturedAt,
      })),
      revisionCount: revisions.length,
    };
  }
}
