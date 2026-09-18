import type { RedactionStatus, Session } from "../../libs/canonical/src/generated.js";

/*
  One vocabulary for "has anyone looked at this yet", shared by sessions and by
  memory documents.

  It used to be spelled out here as a third copy of a list that also exists in
  the contract and in the Rust the agent is built from. Re-exporting the
  generated union means a status added to the model arrives here rather than
  being remembered about.
*/
export type { RedactionStatus };

export interface TenantContext {
  tenantId: string;
  userId: string;
  orgId?: string;
  teamId?: string;
  machineId?: string;
  scopes: readonly string[];
  authType: "browser" | "api_key" | "machine" | "dev" | "mcp";
  /**
   * The `auth_identities` row the caller authenticated with, when the
   * credential is one that can be revoked on its own — an API key today. The
   * MCP handshake records it in the token it mints, so revoking that one key
   * kills that one token.
   */
  credentialId?: string;
}

export interface ArchivedSession extends Session {
  redactionStatus: RedactionStatus;
}

export interface SessionFilter {
  agent?: string;
  workspace?: string;
  machineId?: string;
  model?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

export interface SessionPage {
  items: ArchivedSession[];
  /** How many sessions match the filter, not how many this page holds. */
  total: number;
  nextCursor: string | null;
}
