import type { Session } from "../../libs/canonical/src/generated.js";

export type RedactionStatus = "clear" | "findings" | "reviewed";

export interface TenantContext {
  tenantId: string;
  userId: string;
  orgId?: string;
  teamId?: string;
  machineId?: string;
  scopes: readonly string[];
  authType: "browser" | "api_key" | "machine" | "dev";
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
