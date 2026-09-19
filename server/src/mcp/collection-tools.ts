import { Inject, Injectable } from "@nestjs/common";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { TenantContext } from "../archive-store.js";
import { CollectionService } from "../collections/collections.service.js";
import { CreateCollectionDto } from "../collections/collections.dto.js";
import { parseToolArguments } from "./arguments.js";
import { CollectionMembershipDto, ListCollectionSessionsDto } from "./collection-tools.dto.js";
import { pageSize, toolNames, type McpToolGroup } from "./tool-group.js";

const DEFAULT_LIMIT = 25;

/**
 * Curating collections, not just listing them.
 *
 * `list_collections` existed and nothing else did, so an agent could see that a
 * collection called "auth rewrite" exists and could neither read what is in it
 * nor put anything into it. All four of these are things the web app does from
 * the session detail page and the collections view.
 *
 * Membership is not visibility: `CollectionRecord.sessionIds` decides what a
 * collection lists, while who may read a session is `session.visibility`, which
 * these tools never touch. A team collection is still gated by
 * `CollectionService.create`, which refuses a team the caller is not in.
 */
export const COLLECTION_TOOLS: readonly Tool[] = [
  {
    name: "create_collection",
    description: "Create a curated collection to group related sessions. Optionally scoped to a team the caller belongs to.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: "string", maxLength: 2_000 },
        teamId: { type: "string", description: "Team to scope the collection to. Refused unless the caller is a member." },
      },
    },
  },
  {
    name: "list_collection_sessions",
    description: "List the sessions in one collection as summaries. Take the collectionId from list_collections.",
    inputSchema: {
      type: "object",
      required: ["collectionId"],
      properties: {
        collectionId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: `Page size, default ${DEFAULT_LIMIT}.` },
        offset: { type: "integer", minimum: 0, maximum: 10_000 },
      },
    },
  },
  {
    name: "add_session_to_collection",
    description: "Put a session into a collection. Membership decides what the collection lists; it does not change who can read the session.",
    inputSchema: { type: "object", required: ["collectionId", "sessionId"], properties: { collectionId: { type: "string" }, sessionId: { type: "string" } } },
  },
  {
    name: "remove_session_from_collection",
    description: "Take a session out of a collection. The session itself is untouched.",
    inputSchema: { type: "object", required: ["collectionId", "sessionId"], properties: { collectionId: { type: "string" }, sessionId: { type: "string" } } },
  },
] as const;

const COLLECTION_TOOL_NAMES = toolNames(COLLECTION_TOOLS);

@Injectable()
export class McpCollectionTools implements McpToolGroup {
  readonly tools = COLLECTION_TOOLS;

  constructor(@Inject(CollectionService) private readonly collections: CollectionService) {}

  handles(name: string): boolean {
    return COLLECTION_TOOL_NAMES.has(name);
  }

  async call(context: TenantContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name === "create_collection") {
      return { collection: await this.collections.create(context, parseToolArguments(CreateCollectionDto, args)) };
    }
    if (name === "list_collection_sessions") return this.listSessions(context, args);
    const membership = parseToolArguments(CollectionMembershipDto, args);
    await this.collections.setMembership(context, membership.collectionId, membership.sessionId, name === "add_session_to_collection");
    return { collectionId: membership.collectionId, sessionId: membership.sessionId, member: name === "add_session_to_collection" };
  }

  private async listSessions(context: TenantContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = parseToolArguments(ListCollectionSessionsDto, args);
    const limit = pageSize(request.limit, DEFAULT_LIMIT, 100);
    const offset = request.offset ?? 0;
    // The service resolves the collection inside the tenant and returns
    // summaries, which carry no turns: the page bound is a bound on rows, and a
    // row is small by construction.
    const { items } = await this.collections.listSessions(context, request.collectionId);
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
  }
}
