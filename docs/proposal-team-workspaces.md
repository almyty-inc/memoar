# Proposal: team workspaces (shared-by-default team archives)

Status: **proposal, awaiting ACK in `#memoar`** per `AGENTS.md:6`.
Scope: contract shape only. No implementation, no migration written.

## 0. The ask

> Beyond per-grant `share_grants`: a workspace scope where members' sessions are
> visible and searchable to each other by default (opt-in per session/machine),
> so teams and their agents can build on each other's work.

## 1. What already exists (so we do not rebuild it)

- **Team scope already exists and is already cross-tenant.** `teams` /
  `organizations` (`server/src/migrations/1700000000000-Initial.ts:38-47`) plus
  `team_members` (`server/src/migrations/1700000008000-TeamScope.ts:8-18`).
  `team_members` carries a `tenantId` per member and is deliberately **not**
  under RLS — `server/src/entities/identity.ts:40` states why: it carries
  account metadata, not session content.
- **Team reads already fan out across tenants.**
  `PostgresTeamStore.listTeamSessions` (`server/src/store/postgres/teams.ts:77-94`)
  collects member tenants, then for each one opens its own tenant-scoped
  transaction and selects
  `visibility->>'scope' = 'team' AND visibility->>'teamId' = $2`
  (`teams.ts:83`). This is the pattern the proposal extends.
- **Per-session team visibility already exists in the canonical contract.**
  `Visibility.scope: "private" | "team" | "org" | "link"` with an optional
  `teamId` (`server/libs/canonical/src/generated.ts:33-38`), stored as
  `sessions.visibility jsonb` (`Initial.ts:96`) and written by
  `SharingService.updateVisibility` (`server/src/sharing/sharing.service.ts:75-95`).
- **Widening beyond private requires a completed redaction review**
  (`sharing.service.ts:82-85`, `requireCurrentReview` at `:63-73`).
- **RLS**: one policy shape, applied to every tenant table
  (`Initial.ts:229-238`), plus later tables (`SessionIdentity:22-35`,
  `ArtifactSessions:27-37`, `MachineCommands:22-27`, `MemoryDocuments:61-67`).
  Predicate: `"tenantId" = nullif(current_setting('memoar.tenant_id', true), '')::uuid`.
  The GUC is set by `TenantRunner.inTenant`
  (`server/src/store/postgres/runner.ts:21-26`); the runtime role is
  `NOSUPERUSER NOBYPASSRLS` (`AppRole:28`), which is what makes FORCE actually
  bite. The invariants are asserted in `server/test/migrations.test.ts:15-18`
  (forced tables) and `:95-117` (a real cross-tenant leak probe).
- **Search is hard-pinned to exactly one tenant, twice over.** Both backends set
  the GUC *and* add a literal `"tenantId" = $1` predicate:
  `server/src/search/backends.ts:71-79` (lexical FTS) and
  `server/src/search/embeddings.ts:98-105` (pgvector). Fusion happens in
  `server/src/search/search.service.ts:10-20`.
- **`share_grants` / `share_tokens`** serve a different population: a bearer with
  no account and no tenant. `share_tokens` is a deliberately non-RLS cross-tenant
  lookup (`server/src/entities/sharing.ts:91-112`) and the token is resolved by
  synthesizing an owner context (`sharing.service.ts:137-148`).

### Naming collision — read this before naming anything

`workspace` is **already taken** in the canonical contract: `WorkspaceDescriptor`
is the local checkout path (`generated.ts:12-16`), surfaced as `workspace` in
every session summary (`server/src/sessions.ts:41`) and as a search filter
(`backends.ts:15,77`, `embeddings.ts:103`). Calling the new construct a
"workspace" in the data model would make `workspace` mean two things in one
response body.

**Decision: the user-facing feature is called a team workspace; the data model
word stays `team`.** Nothing named `workspace*` is added to a table, a column or
a `Visibility` scope.

## 2. Data model

### 2.1 Central decision

**A team workspace is a grouping *across* tenants, not a tenant and not a
grouping inside one.** Every session keeps the `tenantId` of the member who
captured it. Nothing is ever copied, re-homed, or re-stamped with a different
tenant.

The three options and why:

| Option | Verdict |
|---|---|
| Workspace *is* a new tenant; members' sessions move into it | Rejected. Moving rows across tenants means a privileged write path that crosses the RLS boundary, on the tables that hold transcripts. It also destroys personal ownership: leaving the team would require moving rows back. |
| Workspace is a grouping *inside* one tenant (all members share a tenant) | Rejected. `team_members.tenantId` already models one tenant per member (`TeamScope.ts:12`), and a shared tenant makes RLS a no-op between members — a member who left would still be inside the policy's `USING` clause. |
| **Workspace is a cross-tenant grouping; reads fan out per tenant** | **Chosen.** It is what the existing team scope already does (`teams.ts:77-94`), it requires **zero policy changes**, and every read still happens under a single-tenant GUC. |

### 2.2 New table (one)

```
team_share_optins
  id           uuid primary key
  "teamId"     uuid not null references teams(id) on delete cascade
  "tenantId"   uuid not null            -- the *sharing* member's tenant
  "userId"     uuid not null
  "machineId"  uuid null                -- null = every machine of that tenant
  "createdAt"  timestamptz not null default now()
  unique ("teamId", "tenantId", "machineId")

  create index team_share_optins_team_idx on team_share_optins ("teamId");
```

Not under RLS, with the same justification as `team_members`
(`identity.ts:40`), `transfer_offers` (`sharing.ts:68`) and `share_tokens`
(`sharing.ts:91`): it carries membership/consent metadata only, never session
content. This is an *extension* of an existing, documented exemption class, not a
new one.

`machineId` is a plain uuid, not a FK: `machines` is under forced RLS
(`Initial.ts:3-19` table list), so a FK from a non-RLS table would be an
awkward cross-policy reference. Ownership is checked in the service before the
row is written.

### 2.3 No other schema change

- No new column on `sessions`. The per-session truth is the existing
  `sessions.visibility` jsonb.
- No index on `sessions` beyond what exists.
  `sessions_tenant_updated_idx ("tenantId", "capturedUpdatedAt" DESC, id)`
  (`Initial.ts:105`) and `sessions_fts_idx` (`:106`) already serve the fan-out,
  because each fan-out query is still a single-tenant query.
- No change to `Visibility` in `contracts/source/canonical.model.json`. `scope`
  stays `private | team | org | link`. **This proposal changes `openapi.yaml`
  only — the canonical model is untouched.**

### 2.4 How a session becomes team-visible

At ingest, if the capturing tenant has an opt-in row for team T matching the
session's `source.machineId` (`generated.ts:4-10`, surfaced at `sessions.ts:41`),
the session is written with `visibility = { scope: "team", teamId: T, ownerId }`
instead of `private`. **The opt-in is materialized into `sessions.visibility` at
write time, not evaluated at read time.** That single choice is what lets
`listTeamSessions` (`teams.ts:77-94`) keep working unchanged and keeps every
read path a plain single-tenant query.

Gate: auto-stamping applies only when the session's `redactionStatus` is
`'clear'` (`Initial.ts:97`). A session with `findings` stays `private` until a
human completes a review, preserving the invariant at `sharing.service.ts:82-85`
rather than punching a hole in it. (Named risk R3 below.)

One session, one team: `Visibility.teamId` is singular. A tenant opted into two
teams stamps the *first* matching opt-in by `createdAt` and the API rejects a
second opt-in for the same `(tenantId, machineId)` pair with 409. Multi-team
sessions are out of scope (§7).

## 3. RLS story

**No policy is created, dropped or altered. No table loses FORCE. No new table
is added to the forced-RLS set, because the one new table holds no session
content.** `server/test/migrations.test.ts:15-18` and its leak probe at `:95-117`
pass unmodified.

### Why a member of workspace A provably cannot read a session from workspace B

The argument is a chain, and every link is code that exists today:

1. Every read of `sessions`, `turns`, `content_blocks`, `raw_artifacts` goes
   through `TenantRunner.inTenant`, which opens a transaction and sets
   `memoar.tenant_id` to **one** tenant id (`runner.ts:21-26`). The search
   backends do the same inline (`backends.ts:73`, `embeddings.ts:99`).
2. Those tables are `FORCE ROW LEVEL SECURITY` with
   `USING ("tenantId" = current_setting('memoar.tenant_id'))` (`Initial.ts:230-237`),
   and the runtime role is `NOSUPERUSER NOBYPASSRLS` (`AppRole:28`), so the
   policy is not bypassable by the API process.
3. Therefore the *only* question is: **which tenant ids can the request loop
   over?** For a team request, that list is
   `SELECT DISTINCT "tenantId" FROM team_members WHERE "teamId" = $1`
   (`teams.ts:72-75`), reachable only after
   `TeamsService.requireMember(teamId, context.userId)`
   (`server/src/teams.ts:12-16`, called at `:32,39,44,49`).
4. Workspace B's member tenants are not in workspace A's `team_members` rows,
   so they are never bound into the GUC for an A request. No SQL text in the A
   request can name a B tenant.

The guarantee is therefore: *RLS bounds each query to one tenant; membership
bounds the set of tenants a request may iterate.* Weakening either is what a
reviewer should watch for.

### Where the guarantee is weaker than it looks — say it plainly

- **Within the fan-out, RLS is no longer the thing keeping a member's private
  sessions private.** Once the loop is inside tenant X's transaction, the policy
  is satisfied for *every* row tenant X owns, including X's private sessions.
  The only thing filtering them is the application predicate
  `visibility->>'scope' = 'team' AND visibility->>'teamId' = $teamId`
  (`teams.ts:83`). Drop that clause in a refactor and you leak one member's
  private archive to their teammates — silently, with RLS reporting success.
  This is already true of `listTeamSessions` today; this proposal makes that
  code path hot instead of rare, and extends it to search, where the predicate
  has to be repeated in two more SQL strings (`backends.ts:75`,
  `embeddings.ts:101`). **Mitigation to build with the feature: a single shared
  `teamVisibilityPredicate()` helper used by all three call sites, and a test
  that fans out over two tenants where one holds a private session and asserts
  it never appears.**
- **The rejected alternative, for the record:** making the RLS predicate accept a
  set (`"tenantId" = ANY(current_setting('memoar.tenant_ids'))`) so one query can
  span the team. That is the design that leaks: a single mis-set GUC, one
  forgotten `set_config` reset on a pooled connection, or one route that builds
  the list from user input, and it is cross-tenant. **Rejected. The policy stays
  single-valued.**

## 4. Opt-in semantics

- **Where the flag lives.** `team_share_optins`, keyed
  `(teamId, tenantId, machineId)`. `machineId = NULL` means every machine of that
  tenant, including future ones.
- **Default.** No row. **Default is off.** Creating a team, or being added to
  one, shares nothing.
- **Per-session opt-in/out needs no new field.** It is the existing
  `sessions.visibility`, changed via the existing
  `PUT /sessions/{id}/visibility` (`sharing.service.ts:75-95`). Set a session to
  `private` and it drops out of the team view immediately, even while the
  machine stays enrolled. Set a single session to `team` and it appears, even
  with no opt-in row at all — today's behaviour, unchanged.
- **Already-archived sessions.** Enrolling is **not retroactive**. Only sessions
  ingested after the opt-in are stamped. Rationale: a standing consent to share
  *what I do from now on* is a different consent from *everything I have ever
  captured on this laptop*, and the redaction review was designed for exactly
  that difference.
- **Revocation.** Deleting the opt-in row stops future stamping. It is
  **not retroactive by default** — sessions already stamped keep
  `visibility.scope = "team"`. This matches the existing share semantics
  (`docs/sharing-and-convert.md:11`). `DELETE .../optins/{machineId}?revokePast=true`
  is offered as an explicit, opt-in-to-opt-out flag that walks the caller's own
  sessions (single-tenant, ordinary RLS write) and resets `visibility` to
  `private`.
- **What revocation can never undo.** A teammate may already have imported a
  copy into their own tenant (`copyTransferredSession`, used at
  `sharing.service.ts:159-161`), which carries provenance but lives in *their*
  tenant and is outside the sharer's reach forever. The UI must say this at the
  moment of enrolment, not at the moment of revocation.

## 5. Scopes and API surface

### 5.1 Scopes

**No new token scope.** Justification:

- Reading team content already resolves to `archive:read` via the guard's path
  inference (`server/src/auth/auth.guard.ts:14-23`: `/teams` matches no special
  branch, so GET → `archive:read`).
- Creating an opt-in is a sharing decision and must require `sharing:write`.
  The guard would infer `archive:write` for a POST under `/teams`
  (`auth.guard.ts:22`), which is wrong, so the opt-in handlers carry an explicit
  `@RequireScopes("sharing:write")` (`server/src/auth/decorators.ts:9`) rather
  than relying on path inference. `sharing:write` is already in `PASSWORD_SCOPES`
  (`server/src/bootstrap-account.ts:52-55`), so no token reissue is needed.
- **Machines get nothing.** Machine tokens hold
  `["ingest:write", "machine:heartbeat", "materialize:read"]`
  (`server/src/auth/auth.service.ts:311,323`) and the guard confines them to
  `/ingest` and `/memory` (`auth.guard.ts:72-80`). A machine must not be able to
  read a teammate's transcript. Unchanged.

Side note found while reading: `PUT /teams/{teamId}/members` today requires only
`archive:write`, because the guard has no `/teams` branch. Adding a member is a
sharing act; it should carry `sharing:write`. Small, separable fix — worth doing
with this work.

### 5.2 Routes (additive; `openapi.yaml` only)

| Route | Purpose |
|---|---|
| `GET /teams/{teamId}/optins` | The caller's own opt-in rows for this team. |
| `PUT /teams/{teamId}/optins` | Body `{ machineId?: uuid }`. Enrol this tenant (or one machine). `sharing:write`. 409 if the tenant is already enrolled in another team. |
| `DELETE /teams/{teamId}/optins/{machineId}` | `?revokePast=true` to also reset already-stamped sessions. `sharing:write`. |
| `GET /teams/{teamId}/search` | Fan-out search. Same query/response shape as `GET /search` (`server/src/search/search.service.ts:162-171`). |
| `GET /teams/{teamId}/sessions/{sessionId}` | Read one teammate's team-visible session, resolved through the same membership fan-out. |

`GET /teams/{teamId}/sessions` and `/collections` already exist
(`server/src/teams.ts:88-96`, `contracts/openapi.yaml:714,729`) and are unchanged.

Deliberately **not** done: adding `?teamId=` to the existing `GET /search`.
Keeping the cross-tenant path on its own route means the single-tenant search
code cannot accidentally acquire a fan-out mode, and an auditor can see at a
glance which handler crosses tenants.

### 5.3 Search behaviour — the part most likely to go wrong

`GET /teams/{teamId}/search` runs, for each member tenant from
`team_members`, the **existing** lexical (`backends.ts:71-119`) and semantic
(`embeddings.ts:95-120`) queries — unmodified except for one extra `AND` on the
team-visibility predicate — each inside its own single-tenant transaction, then
merges every tenant's ranked list through the existing RRF
(`search.service.ts:10-20`). RRF is rank-based, so it fuses lists from different
tenants without needing comparable absolute scores.

Honest costs:

- **N round-trips per query**, N = distinct member tenants. Bounded concurrency
  and a hard cap on N (proposal: 25; beyond that the request 400s and the team
  needs a different design). This is the price of not having a cross-tenant
  index, and it is the right price — see the rejected alternative in §3.
- **Per-tenant `LIMIT` then merge** over-fetches: each tenant must return its own
  `limit` candidates so the merge has something to rank. Memory is bounded by
  `N × limit` summaries, not by transcripts — hydration
  (`backends.ts:111`) stays per-tenant.
- **Semantic search degrades per tenant, not globally.** `SearchService.execute`
  already falls back to lexical on a semantic failure (`search.service.ts:50-57`);
  in a fan-out the fallback must be decided once for the whole request, or
  results become a mix of two ranking regimes. Proposal: if any tenant's semantic
  leg fails, the whole request reports `realizedMode: "lexical"` and uses the
  lexical legs only.

### 5.4 MCP

`search_sessions` and `pack` (`server/src/mcp.ts:18-39`) take an optional
`teamId` argument. Absent, behaviour is byte-identical to today. Present, the
tool resolves through the team route. `get_session` and `get_excerpt` resolve a
teammate's session id through `GET /teams/{teamId}/sessions/{sessionId}` — the
tenant-scoped `getSession` is **not** loosened. `list_collections` and
`save_note` are unchanged: a note is written to the author's own tenant, always.

## 6. Migration path

- **One migration**: create `team_share_optins` + its index. It touches no
  existing table, so `down()` is a single `DROP TABLE`, and the
  apply/revert/re-apply test (`migrations.test.ts:65-84`) needs nothing special.
  Registered in `MIGRATIONS` (`server/src/data-source.ts:19-25`) as
  `TeamShareOptins1700000013000`.
- **`share_grants` and `share_tokens` are kept, unchanged, and are not
  subsumed.** They solve a problem workspaces cannot: a bearer with no account
  and no tenant, resolved by token hash through a non-RLS lookup
  (`sharing.service.ts:137-148`, `entities/sharing.ts:91-112`). A workspace only
  serves accounts that already exist and are already in `team_members`. No
  existing grant is migrated, revoked or reinterpreted.
- **No backfill.** Existing sessions keep `visibility.scope = "private"`.
- **No canonical contract bump.** `contracts/source/canonical.model.json` is
  untouched. `contracts/openapi.yaml` gains five paths (a minor bump).

  *Observation, not part of this proposal:* the three version markers currently
  disagree — `contracts/VERSION` is `0.2.0`, `canonical.model.json`
  `contractVersion` is `0.3.0` (`server/libs/canonical/src/generated.ts:2`), and
  `openapi.yaml` `info.version` is `0.1.1`. Worth confirming which one this
  change is supposed to move before anyone writes it.

## 7. Deliberately left out

| Left out | Why |
|---|---|
| A `workspaces` table separate from `teams` | Teams already are this. A parallel hierarchy would need its own membership, its own RLS story and its own `Visibility` scope, for no capability the team scope lacks. |
| A roles/permissions matrix (owner/admin/viewer) | Teams have none today and `contracts/openapi.yaml:691` says so on purpose. Adding one here makes this a permissions proposal instead of a sharing proposal. |
| A new `Visibility.scope` value (`"workspace"`) | Would be a canonical contract break for zero behavioural gain over `"team"`. |
| Cross-tenant single-index search | The design that leaks (§3). Never. |
| Retroactive backfill of past sessions at enrolment | Consent asymmetry (§4). A separate, explicit bulk action can be proposed later once the redaction-review story for bulk is worked out. |
| Org-level (`scope: "org"`) default sharing | `Visibility.orgId` exists in the contract but nothing reads it; adding org defaults means designing org membership, which does not exist. |
| Write access to a teammate's session (notes, tags, masks on someone else's transcript) | Every mutation path is tenant-scoped; cross-tenant writes are a much larger and much more dangerous change. Read and search only. |
| An activity feed / "new in your workspace" notifications | Product surface, not contract. |
| Per-collection sharing defaults | `collections.teamId` already exists (`TeamScope.ts:19`) and is read by `listTeamCollections` (`teams.ts:96-103`). Unchanged, and out of scope. |

## 8. Risk register

| # | Risk | Severity | Note |
|---|---|---|---|
| R1 | **The application-level visibility predicate is the only thing separating a member's private sessions from their teammates inside a fan-out.** RLS is satisfied for every row of that tenant once the loop is inside it. | High | §3. Mitigation: one shared predicate helper across `teams.ts:83`, `backends.ts:75`, `embeddings.ts:101`, plus a two-tenant fan-out test asserting a private session never surfaces. |
| R2 | **Anyone in a team can add anyone to it.** `TeamsService.addMember` only checks that the *caller* is a member (`server/src/teams.ts:31-36`), there is no invitation acceptance, and `team_members` is not under RLS. With default-on sharing, one compromised member account turns the whole team's archives on for an attacker-chosen address. Today's per-session widening is the brake this removes. | **Highest — this is the cross-tenant leak path** | Mitigation, and I would treat it as a ship blocker: a pending-membership state, where a newly added member's tenant is excluded from every fan-out until that account accepts. |
| R3 | Auto-stamping at ingest bypasses the human redaction review that `sharing.service.ts:82-85` requires for every other widening. | High | Mitigated in §2.4 by stamping only `redactionStatus = 'clear'` sessions — but that is the *detector's* verdict, not a human's. If the team judges that insufficient, the alternative is requiring a one-time acknowledged waiver at enrolment, recorded on the opt-in row. Flagging rather than deciding. |
| R4 | Revocation is not retroactive, and imports can never be revoked. | Medium | §4. A disclosure problem more than a technical one: the warning belongs at enrolment. |
| R5 | Fan-out search cost is linear in member tenants; a large team makes search slow rather than wrong. | Medium | Cap N, bound concurrency, measure before raising the cap. |
| R6 | The word "workspace" already means the local checkout path in every session summary and search filter. | Medium | §1. Resolved by keeping the data model word `team`; still a documentation and UI-copy hazard. |
| R7 | A tenant enrolled in two teams has one `Visibility.teamId` to give. | Low | Resolved by rejecting the second enrolment with 409 (§2.4). Multi-team sharing deliberately deferred. |
| R8 | `team_share_optins` is a new non-RLS table, growing the exempt set. | Low | It holds no session content, matching the stated rationale for `team_members` (`identity.ts:40`), `transfer_offers` (`sharing.ts:68`) and `share_tokens` (`sharing.ts:91`). Worth re-checking at review that it never gains a content-bearing column. |

## 9. Summary of decisions

1. A team workspace **is the existing team** — cross-tenant, sessions stay in the
   owner's tenant. Not a new tenant. Not a grouping inside one.
2. **One new table**, `team_share_optins`, not under RLS, no session content.
3. **Zero RLS policy changes.** Every read is still a single-tenant query under
   the single-valued GUC; membership bounds which tenants a request may iterate.
4. **Opt-in is materialized into `sessions.visibility` at ingest**, never
   evaluated at read time — which is why no read path changes shape.
5. **Default off. Revocation is not retroactive** (with an explicit flag to make
   it so). Per-session control reuses the existing visibility endpoint.
6. **Search fans out per member tenant and merges through the existing RRF.**
   The cross-tenant single-index alternative is rejected outright.
7. **No new scopes; no canonical contract change.** `share_grants` kept
   untouched and unsubsumed.
