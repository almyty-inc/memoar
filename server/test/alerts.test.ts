import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { registry, renderMetrics } from "../src/metrics/metrics.registry.js";

interface Rule {
  alert?: string;
  expr?: string;
  for?: string;
  labels?: { severity?: string };
  annotations?: { summary?: string; description?: string };
}

const alerts = parse(readFileSync(resolve(process.cwd(), "../deploy/alerts.yml"), "utf8")) as {
  groups: { name: string; rules: Rule[] }[];
};

const rules = alerts.groups.flatMap((group) => group.rules);

/** Suffixes Prometheus derives from a metric rather than ones we declare. */
const DERIVED = ["", "_bucket", "_sum", "_count", "_total"];

/**
 * A dashboard that queries a metric which no longer exists is not broken in any
 * visible way: the panel is simply empty, which looks exactly like a quiet
 * system. Same failure as an alert on a renamed metric, and the same guard.
 */
describe("the dashboard", () => {
  const dashboard = JSON.parse(readFileSync(resolve(process.cwd(), "../deploy/dashboard.json"), "utf8")) as {
    title: string;
    panels: { title: string; type: string; targets?: { expr: string }[] }[];
  };

  it("only queries metrics this service exposes", async () => {
    const exposition = await renderMetrics();
    const declared = new Set(
      exposition.split("\n").filter((line) => line.startsWith("# TYPE ")).map((line) => line.split(" ")[2] ?? ""),
    );

    const referenced = new Set<string>();
    for (const panel of dashboard.panels) {
      for (const target of panel.targets ?? []) {
        for (const match of target.expr.matchAll(/memoar_[a-z0-9_]+/gu)) referenced.add(match[0]);
      }
    }
    expect(referenced.size, "the dashboard queries nothing at all").toBeGreaterThan(8);

    const missing = [...referenced].filter((name) =>
      !DERIVED.some((suffix) => name.endsWith(suffix) && declared.has(suffix ? name.slice(0, -suffix.length) : name)));
    expect(missing, `these panels would silently render empty: ${missing.join(", ")}`).toEqual([]);
  });

  it("leads with the failure nothing else would show", () => {
    // Capture stopping is invisible from every other angle: the archive keeps
    // serving what it already holds, so health, latency and error rate all stay
    // exactly as they were.
    const first = dashboard.panels.find((panel) => panel.type !== "row");
    expect(first?.title).toContain("received");
    expect(JSON.stringify(first)).toContain("memoar_ingest_artifacts_total");
  });

  it("explains what each graph is for", () => {
    // A panel whose meaning lives in the head of whoever added it is a panel
    // that gets misread at three in the morning.
    const explained = dashboard.panels.filter((panel) => panel.type !== "row" && "description" in panel);
    expect(explained.length, "at least the non-obvious panels carry a description").toBeGreaterThan(5);
  });
});

describe("the alert rules", () => {
  it("only refers to metrics this service actually exposes", async () => {
    // The failure this prevents: a metric is renamed, every dashboard is fixed
    // because someone is looking at it, and the alert that was supposed to
    // notice capture stopping silently stops evaluating. An alert on a metric
    // that does not exist never fires and never complains.
    const exposition = await renderMetrics();
    const declared = new Set(
      exposition.split("\n")
        .filter((line) => line.startsWith("# TYPE "))
        .map((line) => line.split(" ")[2] ?? ""),
    );

    const referenced = new Set<string>();
    for (const rule of rules) {
      for (const match of (rule.expr ?? "").matchAll(/memoar_[a-z0-9_]+/gu)) referenced.add(match[0]);
    }
    expect(referenced.size, "the rules reference no metrics at all").toBeGreaterThan(5);

    const missing = [...referenced].filter((name) =>
      !DERIVED.some((suffix) => name.endsWith(suffix) && declared.has(suffix ? name.slice(0, -suffix.length) : name)));

    expect(missing, `these alerts watch metrics that are never exposed: ${missing.join(", ")}`).toEqual([]);
  });

  it("gives every alert a severity and something a person can act on", () => {
    // An alert without a description is a pager that wakes somebody up to tell
    // them a number changed.
    for (const rule of rules) {
      expect(rule.alert, "a rule without a name").toBeTruthy();
      expect(rule.for, `${rule.alert} fires instantly, so a single scrape can page`).toBeTruthy();
      expect(["page", "warning"], `${rule.alert} has no usable severity`).toContain(rule.labels?.severity);
      expect(rule.annotations?.summary, `${rule.alert} has no summary`).toBeTruthy();
      expect((rule.annotations?.description ?? "").length, `${rule.alert} says what happened but not what to do`)
        .toBeGreaterThan(40);
    }
  });

  it("pages only for the failures that lose or hide data", () => {
    // Everything else is a warning. A pager that fires for slow queries at
    // three in the morning is a pager people turn off.
    const paging = rules.filter((rule) => rule.labels?.severity === "page").map((rule) => rule.alert);
    expect(paging).toEqual([
      "MemoarApiDown",
      "MemoarWorkerDown",
      "MemoarServerErrors",
      "MemoarCaptureStopped",
      "MemoarQueueNotDraining",
    ]);
  });

  it("watches capture stopping, which nothing else would notice", async () => {
    // The archive keeps serving what it holds when capture dies, so every
    // health check stays green and every dashboard looks normal. This is the
    // one alert the product cannot do without.
    const capture = rules.find((rule) => rule.alert === "MemoarCaptureStopped");
    expect(capture?.expr).toContain("memoar_ingest_artifacts_total");
    expect(capture?.labels?.severity).toBe("page");

    // And the metric it depends on is one that only moves when a transcript is
    // actually stored, not merely when a request arrives.
    expect(await registry.getSingleMetricAsString("memoar_ingest_artifacts_total")).toContain("counter");
  });
});
