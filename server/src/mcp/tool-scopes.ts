import { ForbiddenException } from "@nestjs/common";

import type { TenantContext } from "../archive-store.js";

/**
 * What one tool costs, and the HTTP route that charges the same price.
 *
 * `route` is not documentation. `mcp-scope-parity.test.ts` feeds it to the
 * guard's own `inferredScopes`, so `scopes` has to be `mcp:use` plus whatever
 * that route already demands — a tool added later with a cheaper gate than the
 * endpoint it wraps fails there rather than shipping.
 */
export interface McpToolGate {
  readonly route: { readonly method: string; readonly path: string };
  readonly scopes: readonly string[];
}

const READ: readonly string[] = ["mcp:use", "archive:read"];
const WRITE: readonly string[] = ["mcp:use", "archive:write"];

/**
 * Every tool, and what a caller must hold to run it.
 *
 * `mcp:use` alone used to be the whole gate. It is inferred for any path
 * containing `/mcp` (see `inferredScopes`), so one scope stood in for every
 * scope the archive has — and `docs/mcp.md` recommended exactly that key. The
 * same credential was refused `POST /v1/annotations` with a 403 and granted
 * `add_annotation` over MCP, which is the same write through a different door.
 *
 * So each tool now states the scope its own route asks for. A tool is never
 * gated on less than its route; where the two differ it is because the route's
 * own inference was wrong about itself, and that was fixed in the guard rather
 * than papered over here — `POST /v1/pack` reads and was inferred as a write
 * purely because of its verb.
 *
 * What a caller must *hold* is this, with one stated allowance on top: holding
 * `mcp:use` satisfies the `archive:read` entries. See `IMPLIED_BY_MCP_USE` for
 * why, and why it goes no further than reads.
 */
export const MCP_TOOL_GATES: Readonly<Record<string, McpToolGate>> = {
  // Finding things.
  search_sessions: { route: { method: "GET", path: "/v1/search" }, scopes: READ },
  list_sessions: { route: { method: "GET", path: "/v1/sessions" }, scopes: READ },
  get_excerpt: { route: { method: "GET", path: "/v1/sessions/:sessionId" }, scopes: READ },
  get_session: { route: { method: "GET", path: "/v1/sessions/:sessionId" }, scopes: READ },
  pack: { route: { method: "POST", path: "/v1/pack" }, scopes: READ },
  get_memory: { route: { method: "POST", path: "/v1/pack" }, scopes: READ },
  list_machines: { route: { method: "GET", path: "/v1/machines" }, scopes: READ },

  // Curating. The four writes below are the ones `mcp:use` alone used to buy.
  list_annotations: { route: { method: "GET", path: "/v1/annotations" }, scopes: READ },
  save_note: { route: { method: "POST", path: "/v1/annotations" }, scopes: WRITE },
  add_annotation: { route: { method: "POST", path: "/v1/annotations" }, scopes: WRITE },
  list_collections: { route: { method: "GET", path: "/v1/collections" }, scopes: READ },
  create_collection: { route: { method: "POST", path: "/v1/collections" }, scopes: WRITE },
  list_collection_sessions: { route: { method: "GET", path: "/v1/collections/:collectionId/sessions" }, scopes: READ },
  add_session_to_collection: { route: { method: "PUT", path: "/v1/collections/:collectionId/sessions/:sessionId" }, scopes: WRITE },
  remove_session_from_collection: { route: { method: "DELETE", path: "/v1/collections/:collectionId/sessions/:sessionId" }, scopes: WRITE },

  // Sharing, read-only by design; see docs/mcp.md.
  list_share_links: { route: { method: "GET", path: "/v1/sharing/links" }, scopes: READ },
  list_transfers: { route: { method: "GET", path: "/v1/sharing/transfers" }, scopes: READ },

  // Instruction files and project memory.
  export_project_memory: { route: { method: "POST", path: "/v1/distillation/projects/export" }, scopes: READ },
  list_memory_documents: { route: { method: "GET", path: "/v1/memory" }, scopes: READ },
  get_memory_document: { route: { method: "GET", path: "/v1/memory/:documentId" }, scopes: READ },
};

/**
 * Every scope this surface can ask for, `mcp:use` first.
 *
 * Derived rather than listed: it is what the handshake may put in a token, and
 * a tool gated on something absent here would mint tokens that cannot run it.
 */
export const MCP_SCOPE_VOCABULARY: readonly string[] = [
  "mcp:use",
  ...[...new Set(Object.values(MCP_TOOL_GATES).flatMap((gate) => [...gate.scopes]))]
    .filter((scope) => scope !== "mcp:use")
    .sort(),
];

/**
 * The one thing this surface prices differently from HTTP, and why.
 *
 * Holding `mcp:use` satisfies `archive:read` for a tool call — here, and
 * nowhere else. Reading this archive is what the scope is *for*: the web app
 * offers it as "connect an MCP client to this archive", and `docs/mcp.md` has
 * named it as the key to create for as long as the endpoint has existed.
 * Refusing every read to that key would not close a hole, it would withdraw a
 * documented grant from every client at once.
 *
 * The allowance stops at reads, and that is the whole of the defect it leaves
 * closed: an `mcp:use` key was refused `POST /v1/annotations` on HTTP and wrote
 * annotations over MCP anyway. `archive:write` is never implied by anything.
 * `MCP_TOOL_GATES` above still states each tool's true cost, so the table stays
 * honest and checkable against the guard; this is the one stated exception to
 * it, and `mcp-scope-parity.test.ts` fails if it ever grows a write.
 */
export const IMPLIED_BY_MCP_USE: readonly string[] = ["archive:read"];

/**
 * The scopes an exchanged credential may pass on to an MCP token.
 *
 * Never more than the credential itself holds, so a handshake cannot be a way
 * around the key's own grant; never more than MCP can spend either, so the
 * wildcard a development identity carries becomes this list rather than the
 * wildcard. A key holding `mcp:use` alone still mints a token holding
 * `mcp:use` alone — which reads the archive over MCP and writes nothing.
 */
export function mcpTokenScopes(held: readonly string[]): string[] {
  if (held.includes("*")) return [...MCP_SCOPE_VOCABULARY];
  return MCP_SCOPE_VOCABULARY.filter((scope) => held.includes(scope));
}

/**
 * Refuses a tool call the caller has not got the scopes for.
 *
 * The wording matters more here than on the HTTP surface: a tool error is the
 * whole of what the model receives, and a model that cannot tell "you may not"
 * from "that failed" retries. So the refusal names the tool, what it costs and
 * which scope is missing, in the problem-details shape `toolErrorText`
 * unwraps — it arrives as `missing_scope: ...`, and `missing_scope` is a stable
 * token a client can branch on.
 */
export function assertToolScopes(context: TenantContext, name: string): void {
  const gate = MCP_TOOL_GATES[name];
  if (!gate) {
    // Fail closed. A tool wired into the registry and left out of the table
    // would otherwise be the one tool on this surface with no gate at all.
    throw new ForbiddenException({
      type: "https://memoar.dev/problems/tool-not-gated",
      title: "Tool has no declared scopes",
      status: 403,
      code: "tool_not_gated",
      detail: `The ${name} tool declares no required scopes, so it cannot be authorized. This is a server defect; please report it.`,
    });
  }
  if (context.scopes.includes("*")) return;
  const held = new Set(context.scopes);
  // The one exception to the table; see `IMPLIED_BY_MCP_USE`.
  if (held.has("mcp:use")) for (const implied of IMPLIED_BY_MCP_USE) held.add(implied);
  const missing = gate.scopes.filter((scope) => !held.has(scope));
  if (missing.length === 0) return;
  throw new ForbiddenException({
    type: "https://memoar.dev/problems/missing-scope",
    title: "Missing required scope",
    status: 403,
    code: "missing_scope",
    detail: `The ${name} tool requires ${gate.scopes.join(" and ")}; this credential is missing ${missing.join(", ")}. `
      + "Do not retry: the call will be refused again until the credential is replaced by one holding that scope.",
  });
}
