import { describe, expect, it } from "vitest";
import type { RawArtifactRecord } from "../src/archive-store.js";
import { isStaleParserVersion, parserVersion } from "../libs/parsers/src/versions.js";
import { mergedSessionIds, selectForReprocess } from "../src/reprocess-selection.js";

/*
  What the repair re-parses. On dev, 9 sessions were written by 156 files: a
  parent transcript and the subagents that named its session id. The repair is
  every artifact linked to such a session, oldest capture first, and nothing
  else, so running it twice or on a healthy archive changes nothing.
*/

let next = 0;
function artifact(sessionIds: string[], sourcePath: string | null, capturedAt: string, status: RawArtifactRecord["status"] = "parsed"): RawArtifactRecord {
  next += 1;
  const sha256 = next.toString(16).padStart(64, "0");
  return {
    id: `0191cafe-0000-7000-8000-${next.toString(16).padStart(12, "0")}`, tenantId: "t", sessionIds, sha256, size: 1,
    objectKey: `raw/${sha256}`, status, source: "claude-code", sourcePath, capturedAt, diagnostic: null,
  };
}

const parentV1 = artifact(["merged"], "/p/s.jsonl", "2026-09-17T15:00:00.000Z");
const parentV2 = artifact(["merged"], "/p/s.jsonl", "2026-09-17T16:00:00.000Z");
const subagent = artifact(["merged"], "/p/s/subagents/agent-a.jsonl", "2026-09-17T15:30:00.000Z");
const growing = [artifact(["alone"], "/p/t.jsonl", "2026-09-17T15:00:00.000Z"), artifact(["alone"], "/p/t.jsonl", "2026-09-17T16:00:00.000Z")];
const upload = artifact(["upload"], null, "2026-09-17T15:00:00.000Z");
const waiting = artifact([], "/p/u.jsonl", "2026-11-25T12:57:00.000Z", "stored");
const all = [parentV2, subagent, ...growing, upload, waiting, parentV1];

describe("choosing what to reprocess", () => {
  it("finds the sessions more than one file writes to, and not a file captured twice", () => {
    expect(mergedSessionIds(all)).toEqual(new Set(["merged"]));
  });

  it("selects every capture behind a merged session, oldest first", () => {
    expect(selectForReprocess(all, { mergedSessions: true }).map((record) => record.sha256))
      .toEqual([parentV1.sha256, subagent.sha256, parentV2.sha256]);
  });

  it("selects by status and by digest", () => {
    expect(selectForReprocess(all, { status: "stored" })).toEqual([waiting]);
    expect(selectForReprocess(all, { sha256: subagent.sha256 })).toEqual([subagent]);
    expect(selectForReprocess(all, {}), "no filter is everything").toHaveLength(all.length);
  });
});

describe("choosing what an older parser wrote", () => {
  const machine = "0191cafe-0000-7000-8000-00000000aaaa";
  const other = "0191cafe-0000-7000-8000-00000000bbbb";
  const sessions = new Map([
    ["merged", { parserVersion: "claude-code:v1:0.4.0", machineId: machine, title: "Real title", tool: "claude-code" }],
    ["alone", { parserVersion: "claude-code:v1:0.5.0", machineId: machine, title: "claude-code imported session", tool: "claude-code" }],
    ["upload", { parserVersion: "claude-code:v1:0.3.0", machineId: other, title: null, tool: "claude-code" }],
  ]);

  it("selects the newest capture of each session still under the placeholder title", () => {
    const selected = selectForReprocess(all, { placeholderTitles: { sessions, machineId: machine } });
    // "alone" has the placeholder and two captures, so only the newer one.
    // "merged" has a real title, and the untitled upload is another machine's.
    expect(selected.map((record) => record.sha256)).toEqual([growing[1]!.sha256]);
  });

  it("selects the newest parsed capture of each session an older parser wrote, on this machine only", () => {
    const selected = selectForReprocess(all, { staleParser: { sessions, machineId: machine } });
    // parentV2 is the newest capture behind "merged". "alone" is current, the
    // upload belongs to another machine, and `waiting` was never parsed.
    expect(selected.map((record) => record.sha256)).toEqual([parentV2.sha256]);
  });

  it("selects across machines only when the run names none", () => {
    const selected = selectForReprocess(all, { staleParser: { sessions, machineId: null } });
    expect(selected.map((record) => record.sha256).sort()).toEqual([parentV2.sha256, upload.sha256].sort());
  });

  it("compares versions within a parser, and counts pending and unknown stamps as stale", () => {
    expect(isStaleParserVersion("claude-code:v1:0.4.0", "claude-code")).toBe(true);
    expect(isStaleParserVersion("claude-code:v1:0.5.0", "claude-code")).toBe(false);
    expect(isStaleParserVersion("claude-code:v1:0.10.0", "claude-code"), "numbers, not strings").toBe(false);
    expect(isStaleParserVersion("codex:rollout-v1:0.3.0", "codex"), "#26's line-by-line parse").toBe(true);
    expect(isStaleParserVersion("pending", "claude-code")).toBe(true);
    expect(isStaleParserVersion(null, "claude-code")).toBe(true);
    expect(isStaleParserVersion("canonical-bundle:v1:0.4.0", "canonical-bundle"), "a bundle is canonical already").toBe(false);
    expect(isStaleParserVersion(parserVersion("zed"), "zed")).toBe(false);
  });
});
