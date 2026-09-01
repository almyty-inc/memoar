import { BadRequestException, Controller, Delete, Get, HttpCode, Inject, Injectable, NotFoundException, Param, ParseUUIDPipe, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { CONTRACT_VERSION, type ContentBlock, type Session, type Turn } from "../libs/canonical/src/generated.js";
import type { ArchivedSession, SessionFilter, SessionStore, TenantContext } from "./archive-store.js";
import { Tenant } from "./auth.js";
import { sourceLabel } from "./source-labels.js";
import { ARCHIVE_STORE } from "./tokens.js";

function positiveInt(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
}

/** Wall-clock minutes between the first and last turn, when both are dated. */
function durationMinutes(session: ArchivedSession): number | null {
  const stamps = session.turns
    .map((turn) => new Date(turn.createdAt).valueOf())
    .filter((value) => Number.isFinite(value));
  if (stamps.length < 2) return null;
  return Math.round((Math.max(...stamps) - Math.min(...stamps)) / 60_000);
}

/**
 * The summary a list shows.
 *
 * Branch, machine, token count and duration were absent, so the client filled
 * them with "unknown", "Archived machine", "0 tokens" and "0m" — placeholders
 * that read as data on every row of the archive. Every one of them is a
 * property of the session, so every one of them is sent, and absent when the
 * session genuinely does not have it.
 */
export function sessionSummary(session: ArchivedSession): Record<string, unknown> {
  const minutes = durationMinutes(session);
  return {
    id: session.id,
    title: session.title,
    ...(session.summary ? { summary: session.summary } : {}),
    source: session.source.tool,
    sourceLabel: sourceLabel(session.source.tool),
    ...(session.source.machineId ? { machineId: session.source.machineId } : {}),
    workspace: session.workspace.path,
    ...(session.workspace.branch ? { branch: session.workspace.branch } : {}),
    ...(session.models[0] ? { model: session.models[0] } : {}),
    updatedAt: session.updatedAt,
    turnCount: session.turns.length,
    tokenCount: session.tokenTotals.input + session.tokenTotals.output,
    ...(minutes === null ? {} : { durationMinutes: minutes }),
    redactionStatus: session.redactionStatus,
  };
}

@Injectable()
export class SessionsService {
  constructor(@Inject(ARCHIVE_STORE) private readonly store: SessionStore) {}

  async list(context: TenantContext, query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    const filter: SessionFilter = {
      limit: positiveInt(query.limit, 30, 100),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.agent ? { agent: query.agent } : {}),
      ...(query.workspace ? { workspace: query.workspace } : {}),
      ...(query.machineId ? { machineId: query.machineId } : {}),
      ...(query.model ? { model: query.model } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
    };
    const page = await this.store.listSessions(context, filter);
    // The total, so a reader can be told how many sessions there are rather
    // than only how many arrived in this page.
    return { items: page.items.map(sessionSummary), total: page.total, nextCursor: page.nextCursor };
  }

  async timeline(context: TenantContext, query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    const page = await this.store.listSessions(context, {
      limit: positiveInt(query.limit, 30, 100),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const session of page.items) {
      const date = session.updatedAt.slice(0, 10);
      groups.set(date, [...(groups.get(date) ?? []), sessionSummary(session)]);
    }
    return {
      groups: [...groups].map(([date, sessions]) => ({ date, sessions })),
      // How many sessions the archive holds, not how many this page carries.
      total: page.total,
      nextCursor: page.nextCursor,
    };
  }

  async getChunk(context: TenantContext, sessionId: string, cursor?: string, chunkSizeValue?: string): Promise<Record<string, unknown>> {
    const session = await this.store.getSession(context, sessionId);
    if (!session) throw new NotFoundException("Session not found");
    const offset = cursor ? Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10) : 0;
    const chunkSize = positiveInt(chunkSizeValue, 50, 200);
    const turns = session.turns.slice(offset, offset + chunkSize);
    const nextOffset = offset + turns.length;
    return {
      session: sessionSummary(session),
      turns,
      // Provenance rides the detail chunk, not the summary, so list responses
      // stay small while the detail view can show how a session got here.
      provenance: session.provenance,
      nextCursor: nextOffset < session.turns.length ? Buffer.from(String(nextOffset)).toString("base64url") : null,
    };
  }

  async remove(context: TenantContext, sessionId: string): Promise<void> {
    if (!await this.store.deleteSession(context, sessionId)) throw new NotFoundException("Session not found");
  }

  async export(context: TenantContext, sessionId: string, format: string): Promise<{ contentType: string; filename: string; body: string }> {
    if (format !== "canonical" && format !== "html") {
      throw new BadRequestException({
        type: "https://memoar.dev/problems/invalid-export-format",
        title: "Invalid export format",
        status: 400,
        code: "invalid_export_format",
        detail: `format must be canonical or html, got: ${format}`,
      });
    }
    const session = await this.store.getSession(context, sessionId);
    if (!session) throw new NotFoundException("Session not found");
    if (format === "canonical") {
      return {
        contentType: "application/json",
        filename: `${session.id}.memoar.json`,
        body: JSON.stringify({ memoarBundle: CONTRACT_VERSION, sessions: [canonicalProjection(session)] }, null, 2),
      };
    }
    return { contentType: "text/html; charset=utf-8", filename: `${session.id}.html`, body: renderSessionHtml(session) };
  }
}

/** Strips the Memoar-only redaction status, leaving a pure canonical session. */
export function canonicalProjection(session: ArchivedSession): Session {
  const canonical: Session & { redactionStatus?: unknown } = { ...session };
  delete canonical.redactionStatus;
  return canonical;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderBlock(block: ContentBlock): string {
  switch (block.kind) {
    case "text":
      return `<div class="block text">${escapeHtml(block.text ?? "")}</div>`;
    case "thinking":
      return `<details class="block thinking"><summary>Thinking</summary><pre>${escapeHtml(block.text ?? "")}</pre></details>`;
    case "tool_call":
      return `<details class="block tool"><summary>Tool call: ${escapeHtml(block.name ?? "unknown")}</summary><pre>${escapeHtml(JSON.stringify(block.data ?? {}, null, 2))}</pre></details>`;
    case "tool_result":
      return `<details class="block tool"><summary>Tool result${block.callId ? ` (${escapeHtml(block.callId)})` : ""}</summary><pre>${escapeHtml(block.text ?? JSON.stringify(block.data ?? {}, null, 2))}</pre></details>`;
    case "diff":
      return `<pre class="block diff">${escapeHtml(block.text ?? "")}</pre>`;
    case "error":
      return `<pre class="block error">${escapeHtml(block.text ?? "")}</pre>`;
    default:
      return `<pre class="block other">${escapeHtml(block.text ?? JSON.stringify(block.data ?? {}, null, 2))}</pre>`;
  }
}

function renderTurn(turn: Turn): string {
  return [
    `<article class="turn ${escapeHtml(turn.role)}">`,
    `<header><span class="role">${escapeHtml(turn.role)}</span><time>${escapeHtml(turn.createdAt)}</time></header>`,
    ...turn.blocks.map(renderBlock),
    "</article>",
  ].join("\n");
}

export function renderSessionHtml(session: ArchivedSession): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(session.title)}</title>`,
    "<style>",
    "body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;background:#101014;color:#e8e8ec}",
    "header.session{border-bottom:1px solid #33333c;padding-bottom:1rem;margin-bottom:1.5rem}",
    ".meta{color:#9a9aa5;font-size:.85rem}",
    ".turn{border:1px solid #26262e;border-radius:8px;padding:.75rem 1rem;margin:1rem 0}",
    ".turn>header{display:flex;justify-content:space-between;color:#9a9aa5;font-size:.8rem;margin-bottom:.5rem}",
    ".turn.user{border-color:#3a4a6b}",
    ".block{margin:.5rem 0;white-space:pre-wrap;word-break:break-word}",
    "pre{overflow-x:auto;background:#16161c;padding:.5rem;border-radius:6px}",
    "details>summary{cursor:pointer;color:#9a9aa5}",
    "</style>",
    "</head>",
    "<body>",
    '<header class="session">',
    `<h1>${escapeHtml(session.title)}</h1>`,
    `<p class="meta">${escapeHtml(session.source.tool)} · ${escapeHtml(session.workspace.path)} · ${escapeHtml(session.updatedAt)} · exported from Memoar (contract ${escapeHtml(CONTRACT_VERSION)})</p>`,
    "</header>",
    ...session.turns.map(renderTurn),
    "</body>",
    "</html>",
  ].join("\n");
}

@Controller("sessions")
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  list(@Tenant() context: TenantContext, @Query() query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    return this.sessions.list(context, query);
  }

  @Get("timeline")
  timeline(@Tenant() context: TenantContext, @Query() query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    return this.sessions.timeline(context, query);
  }

  @Get(":sessionId/export")
  async export(
    @Tenant() context: TenantContext,
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @Res({ passthrough: true }) response: Response,
    @Query("format") format = "canonical",
  ): Promise<string> {
    const exported = await this.sessions.export(context, sessionId, format);
    response.setHeader("content-type", exported.contentType);
    response.setHeader("content-disposition", `attachment; filename="${exported.filename}"`);
    return exported.body;
  }

  @Get(":sessionId")
  get(
    @Tenant() context: TenantContext,
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @Query("cursor") cursor?: string,
    @Query("chunkSize") chunkSize?: string,
  ): Promise<Record<string, unknown>> {
    return this.sessions.getChunk(context, sessionId, cursor, chunkSize);
  }

  @Delete(":sessionId")
  @HttpCode(202)
  async remove(@Tenant() context: TenantContext, @Param("sessionId", ParseUUIDPipe) sessionId: string): Promise<{ queued: true }> {
    await this.sessions.remove(context, sessionId);
    return { queued: true };
  }
}
