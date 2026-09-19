import { Inject, Injectable } from "@nestjs/common";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { TenantContext } from "../archive-store.js";
import { SharingService } from "../sharing/sharing.service.js";
import { parseToolArguments } from "./arguments.js";
import { ListSharingDto } from "./sharing-tools.dto.js";
import { pageSize, toolNames, type McpToolGroup } from "./tool-group.js";

const DEFAULT_LIMIT = 50;

/**
 * Sharing, read-only and deliberately so.
 *
 * An agent should be able to answer "is any of this already public?" before it
 * quotes a session or advises on one — that question is on the web app's
 * workspace view and had no answer over MCP at all. What it must not do is
 * change the answer. Creating a link, widening visibility, sending or accepting
 * a transfer and completing a redaction review are all absent, and
 * `docs/mcp.md` says why; revoking is absent too, because `saveShareGrant`
 * writes `status: "revoked"` with no path back, so an agent cutting off a link
 * a person is relying on could not undo it.
 *
 * Neither tool returns a token. `listLinks` never had one — the secret exists
 * only in the response to `POST /sharing/links` — so an agent can see that a
 * session is shared without being able to use the share.
 */
export const SHARING_TOOLS: readonly Tool[] = [
  {
    name: "list_share_links",
    description: "List this account's share links: which sessions are exposed, with what permission, active or revoked, and when they expire. Read-only, and the link secrets are not returned. Creating or revoking a link is not available over MCP.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, description: `Page size, default ${DEFAULT_LIMIT}.` },
        offset: { type: "integer", minimum: 0, maximum: 10_000 },
      },
    },
  },
  {
    name: "list_transfers",
    description: "List session transfers this account has sent or been offered, with sender, recipient and status. Read-only: requesting, accepting and declining a transfer are not available over MCP.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, description: `Page size, default ${DEFAULT_LIMIT}.` },
        offset: { type: "integer", minimum: 0, maximum: 10_000 },
      },
    },
  },
] as const;

const SHARING_TOOL_NAMES = toolNames(SHARING_TOOLS);

@Injectable()
export class McpSharingTools implements McpToolGroup {
  readonly tools = SHARING_TOOLS;

  constructor(@Inject(SharingService) private readonly sharing: SharingService) {}

  handles(name: string): boolean {
    return SHARING_TOOL_NAMES.has(name);
  }

  async call(context: TenantContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = parseToolArguments(ListSharingDto, args);
    const limit = pageSize(request.limit, DEFAULT_LIMIT, 200);
    const offset = request.offset ?? 0;
    const items: Record<string, unknown>[] = name === "list_share_links"
      ? (await this.sharing.listLinks(context)).items
      : (await this.sharing.listTransfers(context)).map((transfer) => ({ ...transfer }));
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  }
}
