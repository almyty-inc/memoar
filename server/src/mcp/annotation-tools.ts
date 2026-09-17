import { Inject, Injectable } from "@nestjs/common";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Annotation } from "../../libs/canonical/src/generated.js";
import { AnnotationService } from "../annotations/annotations.service.js";
import type { TenantContext } from "../archive-store.js";
import {
  AddAnnotationDto, ListAnnotationsDto, MAX_ANNOTATION_VALUE_CHARS, MCP_ANNOTATION_KINDS,
} from "./annotation-tools.dto.js";
import { parseToolArguments } from "./arguments.js";
import { pageSize, toolNames, type McpToolGroup } from "./tool-group.js";

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_VALUE_CHARS = 4_000;

/**
 * Reading and writing the curation layer.
 *
 * `save_note` could write one kind of annotation and nothing could read any of
 * them back, so an agent could not see the notes, tags or summaries it or
 * anyone else had already attached to a session — including the ones it wrote
 * itself last week. The web app lists them on every session detail page.
 *
 * There is no tool to edit or delete one. `Annotation` carries no author, so a
 * tool cannot tell an agent's note from a person's, deletion has no undo, and
 * the correction an agent actually needs — "that earlier note was wrong" — is a
 * new annotation, not a silent overwrite of someone else's.
 */
export const ANNOTATION_TOOLS: readonly Tool[] = [
  {
    name: "list_annotations",
    description: "List the notes, tags, pins and summaries attached to a session (or to the whole account when sessionId is omitted). This is how an agent reads back what save_note wrote.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Restrict to one session. Omit for the whole account." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: `Page size, default ${DEFAULT_LIMIT}.` },
        offset: { type: "integer", minimum: 0, maximum: 10_000 },
        maxValueChars: { type: "integer", minimum: 200, maximum: 20_000, description: `Per-annotation budget, default ${DEFAULT_MAX_VALUE_CHARS}. Larger values come back as {truncated, preview}.` },
      },
    },
  },
  {
    name: "add_annotation",
    description: `Attach a ${MCP_ANNOTATION_KINDS.join(", ")} annotation to a session, or to one turn or block of it. Use save_note for plain markdown notes; use this for tags, pins and summaries. Redaction masks cannot be written over MCP.`,
    inputSchema: {
      type: "object",
      required: ["sessionId", "kind", "value"],
      properties: {
        sessionId: { type: "string" },
        turnId: { type: "string", description: "Optional turn this annotation is about." },
        blockId: { type: "string", description: "Optional block this annotation is about." },
        kind: { enum: [...MCP_ANNOTATION_KINDS] },
        value: { type: "object", description: `Annotation body, at most ${MAX_ANNOTATION_VALUE_CHARS} characters of JSON. A source field is stamped as "mcp".` },
      },
    },
  },
] as const;

const ANNOTATION_TOOL_NAMES = toolNames(ANNOTATION_TOOLS);

@Injectable()
export class McpAnnotationTools implements McpToolGroup {
  readonly tools = ANNOTATION_TOOLS;

  constructor(@Inject(AnnotationService) private readonly annotations: AnnotationService) {}

  handles(name: string): boolean {
    return ANNOTATION_TOOL_NAMES.has(name);
  }

  async call(context: TenantContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name === "list_annotations") return this.list(context, args);
    return this.add(context, args);
  }

  private async list(context: TenantContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = parseToolArguments(ListAnnotationsDto, args);
    const limit = pageSize(request.limit, DEFAULT_LIMIT, 200);
    const offset = request.offset ?? 0;
    const budget = request.maxValueChars ?? DEFAULT_MAX_VALUE_CHARS;
    const { items } = await this.annotations.list(context, request.sessionId);
    return {
      items: items.slice(offset, offset + limit).map((annotation) => bound(annotation, budget)),
      total: items.length,
      limit,
      offset,
    };
  }

  private async add(context: TenantContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = parseToolArguments(AddAnnotationDto, args);
    if (JSON.stringify(request.value).length > MAX_ANNOTATION_VALUE_CHARS) {
      throw new Error("invalid_arguments:value");
    }
    const annotation = await this.annotations.create(context, {
      sessionId: request.sessionId,
      ...(request.turnId ? { turnId: request.turnId } : {}),
      ...(request.blockId ? { blockId: request.blockId } : {}),
      kind: request.kind,
      // Stamped last so provenance is the tool's to state, not the caller's.
      value: { ...request.value, source: "mcp" },
    });
    return { annotation };
  }
}

/**
 * One annotation, with its body kept inside a budget.
 *
 * A value is arbitrary JSON: a distillation note can be thousands of
 * characters, and a session can carry many. Truncating the JSON would hand back
 * something that no longer parses, so an oversized body is replaced by a
 * preview and says that is what it is.
 */
function bound(annotation: Annotation, maxValueChars: number): Record<string, unknown> {
  const serialized = JSON.stringify(annotation.value);
  return {
    id: annotation.id,
    sessionId: annotation.sessionId,
    ...(annotation.turnId ? { turnId: annotation.turnId } : {}),
    ...(annotation.blockId ? { blockId: annotation.blockId } : {}),
    kind: annotation.kind,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
    ...(serialized.length > maxValueChars
      ? { value: null, valueTruncated: true, valuePreview: serialized.slice(0, maxValueChars) }
      : { value: annotation.value, valueTruncated: false }),
  };
}
