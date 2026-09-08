import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ErrorAggregator, errorAggregator, persistErrors } from "../src/errors/error-aggregator.js";
import { readErrorState, writeErrorState } from "../src/errors/error-store.js";
import { fingerprint, normalizeMessage, originFrame } from "../src/errors/fingerprint.js";
import { handlePipelineJob } from "../src/pipeline-jobs.js";
import { startTestApi, type TestApi } from "./helpers/http-app.js";

const TOKEN = "an-operator-token-nobody-published";

describe("grouping failures", () => {
  afterEach(() => { errorAggregator.reset(); });

  it("strips the archive's content out of a message before keeping it", () => {
    // This is the reason normalisation is not merely a convenience. A real
    // message from a live archive read exactly this, and the id in it came out
    // of somebody's transcript.
    const real = 'invalid input syntax for type uuid: "0191cafe-0000-7000-8000-0000000take0e"';
    const shape = normalizeMessage(real);

    expect(shape).not.toContain("take0e");
    expect(shape).toBe('invalid input syntax for type uuid: "?"');

    // The other shapes that carry content: paths, hashes, ids, numbers.
    expect(normalizeMessage("ENOENT: /Users/someone/projects/secret-startup/session.jsonl"))
      .not.toContain("secret-startup");
    expect(normalizeMessage("artifact cf2b0d3c5369a0f134116bb6de536a5e7e716212af8cc2b5254fbd02fde7e829 missing"))
      .toBe("artifact <hash> missing");
    expect(normalizeMessage("session 0191cafe-0000-7000-8000-00000000d001 not found"))
      .toBe("session <uuid> not found");
  });

  it("counts the same failure once, however many times it happens", () => {
    const aggregator = new ErrorAggregator();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // Different data every time, same failure. Ungrouped, this is five
      // incidents in a log; grouped, it is one problem with a count.
      aggregator.record(new TypeError(`cannot read property of ${attempt}`));
    }

    const { groups, distinct } = aggregator.snapshot();
    expect(distinct, "five occurrences of one shape").toBe(1);
    expect(groups[0]!.count).toBe(5);
    expect(groups[0]!.type).toBe("TypeError");
    expect(groups[0]!.shape).toBe("cannot read property of <n>");
  });

  it("keeps genuinely different failures apart", () => {
    const aggregator = new ErrorAggregator();
    aggregator.record(new TypeError("cannot read x"));
    aggregator.record(new RangeError("cannot read x"));
    expect(aggregator.snapshot().distinct, "same words, different class").toBe(2);
  });

  it("stops growing rather than becoming a leak during an incident", () => {
    // A fingerprint comes from a message, and a bad enough message defeats any
    // normalisation. Unbounded, the thing that reports failures would grow
    // fastest exactly during the incident it exists to explain.
    const aggregator = new ErrorAggregator();
    for (let index = 0; index < 500; index += 1) {
      aggregator.record(new Error(`unique-${String.fromCharCode(97 + (index % 26))}${index}x`));
    }

    const { distinct, dropped } = aggregator.snapshot(1000);
    expect(distinct).toBeLessThanOrEqual(200);
    expect(dropped, "what was dropped is reported rather than silently lost").toBeGreaterThan(0);
  });

  it("ranks by how often, not by how recently", () => {
    const aggregator = new ErrorAggregator();
    for (let index = 0; index < 3; index += 1) aggregator.record(new Error("the common one"));
    aggregator.record(new Error("the rare one"));

    expect(aggregator.snapshot().groups[0]!.shape).toBe("the common one");
  });

  it("points at the frame inside this repository", () => {
    // The top frame is usually node internals or a library. What an operator
    // needs is the first line that belongs to us.
    const stack = [
      "Error: boom",
      "    at BigInt (<anonymous>)",
      "    at incrementUuid (file:///app/dist/libs/parsers/src/common.js:18:26)",
      "    at Array.map (<anonymous>)",
    ].join("\n");

    expect(originFrame(stack)).toBe("common.js:18");
    expect(originFrame(undefined)).toBeNull();
  });

  it("treats the same message thrown from two places as two problems", () => {
    // Otherwise fixing one of them makes the other vanish from the list while
    // it is still happening.
    const here = new Error("boom");
    here.stack = "Error: boom\n    at f (file:///app/dist/src/one.js:10:5)";
    const there = new Error("boom");
    there.stack = "Error: boom\n    at g (file:///app/dist/src/two.js:20:5)";

    expect(fingerprint(here).origin).toBe("one.js:10");
    expect(fingerprint(there).origin).toBe("two.js:20");
    expect(fingerprint(here).id).not.toBe(fingerprint(there).id);
  });

  it("records a failed job, which no request ever sees", async () => {
    // The failure that matters most — a transcript that was never archived —
    // belongs to no request and never reaches the exception filter.
    await expect(handlePipelineJob(
      { name: "parse", data: { tenantId: "0191cafe-0000-7000-8000-000000000001", userId: "0191cafe-0000-7000-8000-000000000001" } },
      {} as never,
    )).rejects.toThrow();

    const { groups } = errorAggregator.snapshot();
    expect(groups[0]!.shape).toBe("parse_job_missing_sha256");
    expect(groups[0]!.lastRoute).toBe("job:parse");
  });
});

describe("surviving a restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "memoar-errors-"));
  const path = join(directory, "errors.json");

  it("carries the counts across, rather than starting again", () => {
    // "This has happened 4,000 times since Tuesday" is the sentence that
    // separates a real problem from a one-off, and the deploy made because of
    // it would otherwise erase exactly that.
    const before = new ErrorAggregator();
    for (let index = 0; index < 7; index += 1) before.record(new Error("the same failure"));
    writeErrorState(path, before.persistable());

    const after = new ErrorAggregator();
    after.restore(readErrorState(path)!);

    expect(after.snapshot().groups[0]).toMatchObject({ shape: "the same failure", count: 7 });
  });

  it("adds to what this process has already seen rather than replacing it", () => {
    const before = new ErrorAggregator();
    before.record(new Error("the same failure"));
    writeErrorState(path, before.persistable());

    const after = new ErrorAggregator();
    // Something failed between starting and reading the file, which is exactly
    // when a restart is happening.
    after.record(new Error("the same failure"));
    after.restore(readErrorState(path)!);

    expect(after.snapshot().groups[0]!.count, "the live occurrence must not be lost").toBe(2);
  });

  it("keeps no archive content in the file", () => {
    // The file gets copied around, attached to tickets, and left on disks. What
    // is written is the normalised shape, never the message that quoted its
    // input.
    const aggregator = new ErrorAggregator();
    aggregator.record(new Error('invalid input syntax for type uuid: "0191cafe-0000-7000-8000-0000000take0e"'));
    writeErrorState(path, aggregator.persistable());

    const written = readFileSync(path, "utf8");
    expect(written).not.toContain("take0e");
    expect(written).toContain('invalid input syntax for type uuid: \\"?\\"');
  });

  it("starts empty rather than refusing to start, when the file cannot be read", () => {
    // This is the component that reports failures. It must not be able to
    // become the one that stops the service.
    const damaged = join(directory, "damaged.json");
    writeFileSync(damaged, '{"groups":[{"id":"x"', "utf8");
    expect(readErrorState(damaged)).toBeNull();
    expect(readErrorState(join(directory, "absent.json"))).toBeNull();
  });

  it("writes atomically, so a crash mid-write cannot empty the list", () => {
    // A write that went straight to the target would leave a truncated file
    // when the process died halfway through it, and the next boot would fail to
    // parse it — the error list emptied by the very restart it exists to
    // survive. Writing to a temporary name and renaming means a crash before
    // the rename leaves the previous file completely intact.
    const atomic = join(directory, "atomic.json");
    const aggregator = new ErrorAggregator();
    aggregator.record(new Error("written before the crash"));
    writeErrorState(atomic, aggregator.persistable());

    // The state a process killed mid-write leaves behind.
    writeFileSync(`${atomic}.writing`, '{"groups":[{"id":"trun', "utf8");

    expect(readErrorState(atomic)!.groups[0]!.shape, "the last good file must still be readable").toBe("written before the crash");
    // And the next successful write clears the debris rather than accumulating it.
    writeErrorState(atomic, aggregator.persistable());
    expect(existsSync(`${atomic}.writing`)).toBe(false);
  });

  it("does nothing at all when no path is configured", () => {
    // The default is what it was: in memory, per process, gone on restart.
    const stop = persistErrors(new ErrorAggregator(), undefined);
    expect(() => { stop(); }).not.toThrow();
  });

  it("loads on start and writes on stop", () => {
    const roundTrip = join(directory, "round-trip.json");
    const first = new ErrorAggregator();
    first.record(new Error("kept across the restart"));
    persistErrors(first, roundTrip, 3_600_000)();

    const second = new ErrorAggregator();
    persistErrors(second, roundTrip, 3_600_000)();

    expect(second.snapshot().groups[0]!.shape).toBe("kept across the restart");
  });
});

describe("the error report endpoint", () => {
  let api: TestApi;
  beforeAll(async () => { api = await startTestApi({ MEMOAR_METRICS_TOKEN: TOKEN }); }, 30_000);
  afterAll(async () => { if (api) await api.close(); });

  it("is not available to a caller without the operator token", async () => {
    expect((await api.request("GET", "/errors", { token: null })).status).toBe(403);
    // An archive's own token is not an operator's: this endpoint describes the
    // deployment, not the caller's sessions.
    expect((await api.request("GET", "/errors")).status).toBe(403);
  });

  it("reports the groups to an operator", async () => {
    errorAggregator.reset();
    errorAggregator.record(new Error('failed on "some-private-value"'), { requestId: "req-1", route: "/v1/sessions" });

    const response = await fetch(`${api.baseUrl}/v1/errors`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    const body = await response.json() as { groups: { shape: string; count: number; lastRequestId?: string }[]; distinct: number };

    expect(body.distinct).toBe(1);
    expect(body.groups[0]!.count).toBe(1);
    // The request id is here so an operator can find the full line in the log;
    // the message's contents are not, because they quote their input.
    expect(body.groups[0]!.lastRequestId).toBe("req-1");
    expect(JSON.stringify(body)).not.toContain("some-private-value");
  });
});
