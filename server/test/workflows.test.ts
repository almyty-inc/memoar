/**
 * The checks on the checks.
 *
 * Every failure this guards against has the same shape: the workflow is green,
 * or absent, and nothing about the repository looks any different either way.
 *
 *   - `agent-distribution.yml` ran only on pull requests. Work lands on main
 *     directly here, so when the desktop crate broke two of its three runners
 *     the workflow simply never ran, and stayed never-run for a fortnight.
 *   - The Rust matrix had no cache while `ci.yml` and `release.yml` both did,
 *     so three runners — two of them billed at ten times the Linux rate —
 *     rebuilt the whole dependency graph on every single run. Nothing goes red
 *     when a cache is missing; the bill goes up.
 *   - Nothing superseded a run, so two pushes a minute apart held two full
 *     macOS and Windows matrices to completion for one answer.
 *
 * None of these can be caught by running the workflows, because a workflow that
 * does not run cannot fail. They are properties of the files.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Step { uses?: string; run?: string; name?: string }
interface Job {
  "runs-on"?: unknown;
  strategy?: { matrix?: Record<string, unknown> };
  steps?: Step[];
}
interface Workflow {
  name?: string;
  on?: Record<string, unknown>;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  jobs?: Record<string, Job>;
}

const WORKFLOW_DIR = resolve(process.cwd(), "..", ".github", "workflows");

function workflow(file: string): Workflow {
  // `on` is YAML 1.1's boolean true, which is why it is read both ways.
  const parsed = parse(readFileSync(resolve(WORKFLOW_DIR, file), "utf8")) as Workflow & { true?: Record<string, unknown> };
  return { ...parsed, on: parsed.on ?? parsed.true ?? {} };
}

const FILES = readdirSync(WORKFLOW_DIR).filter((file) => file.endsWith(".yml"));

/**
 * The workflows whose job is to say whether the code is sound, as opposed to
 * the ones that publish something when they are asked to.
 */
const VERIFYING = ["ci.yml", "agent-distribution.yml"];

/** Workflows that hold several runners for minutes at a time. */
const EXPENSIVE = ["ci.yml", "agent-distribution.yml"];

describe("the workflows that decide whether the code is sound", () => {
  it("finds the workflows at all", () => {
    // A path that quietly matches nothing would make every assertion below
    // pass by vacuum, which is the failure this whole file is about.
    expect(FILES.sort()).toEqual(["agent-distribution.yml", "build-publish.yml", "ci.yml", "release.yml"]);
  });

  it.each(VERIFYING)("%s runs on pushes to main as well as on pull requests", (file) => {
    // The one that did not is the one that was broken for a fortnight without
    // anybody being able to know. A verification workflow that only runs on
    // pull requests reports on drafts and never on what shipped.
    const triggers = workflow(file).on ?? {};
    expect(Object.keys(triggers), `${file} does not run on a push at all`).toContain("push");

    const push = triggers.push as { branches?: string[] } | null;
    expect(push?.branches, `${file} runs on a push but not on main`).toContain("main");
    expect(Object.keys(triggers), `${file} does not run on pull requests`).toContain("pull_request");
  });

  it.each(EXPENSIVE)("%s supersedes its own older runs on a branch", (file) => {
    const concurrency = workflow(file).concurrency;
    expect(concurrency?.group, `${file} lets two runs of itself proceed in parallel`).toBeTruthy();
    expect(String(concurrency?.group), `${file} groups by workflow but not by ref`).toContain("github.ref");
    // Cancelling on main would leave the branch with no verdict at all, so the
    // cancellation is conditional rather than flat true.
    expect(String(concurrency?.["cancel-in-progress"]), `${file} never supersedes anything`)
      .toMatch(/pull_request|true/u);
  });
});

describe("compiling Rust in CI", () => {
  /** Every job, across every workflow, that invokes cargo. */
  const rustJobs = FILES.flatMap((file) => {
    const jobs = Object.entries(workflow(file).jobs ?? {});
    return jobs
      .filter(([, job]) => (job.steps ?? []).some((step) => (step.run ?? "").includes("cargo ")))
      .map(([id, job]) => ({ file, id, job }));
  });

  it("finds the jobs that compile", () => {
    expect(rustJobs.length, "no job in this repository compiles Rust, which cannot be right").toBeGreaterThan(2);
  });

  it.each(rustJobs.map((entry) => [`${entry.file}:${entry.id}`, entry] as const))(
    "%s restores a cargo cache rather than rebuilding from cold",
    (_label, entry) => {
      // A missing cache never turns a run red. It costs minutes on every run
      // instead, and on the macOS and Windows runners it costs them at ten
      // times the Linux rate — which is exactly why nobody noticed for weeks.
      const cached = (entry.job.steps ?? []).some((step) => (step.uses ?? "").startsWith("Swatinem/rust-cache@"));
      expect(cached, `${entry.file}:${entry.id} compiles Rust with no cache, so every run starts from scratch`).toBe(true);
    },
  );

  it("keys the per-OS matrix caches apart", () => {
    // One cache shared by three operating systems is a cache that each of them
    // keeps evicting for the others, which reads as "caching is not helping"
    // rather than as a misconfiguration.
    for (const entry of rustJobs) {
      const matrix = entry.job.strategy?.matrix;
      if (!matrix || !("os" in matrix)) continue;
      const cache = (entry.job.steps ?? []).find((step) => (step.uses ?? "").startsWith("Swatinem/rust-cache@"));
      expect((cache as { with?: { key?: string } } | undefined)?.with?.key,
        `${entry.file}:${entry.id} runs a matrix through one shared cache key`).toBeTruthy();
    }
  });
});

describe("the release workflow", () => {
  const release = workflow("release.yml");

  it("builds every platform the launcher will try to download", () => {
    // v0.3.0 shipped five binaries while `lib/platform.js` mapped six
    // platform pairs, so `npx memoar` on Windows on ARM resolved
    // memoar-aarch64-pc-windows-msvc.exe and got a 404 from GitHub — after the
    // launcher had already told the user the platform was supported.
    const matrix = release.jobs?.build?.strategy?.matrix as { include?: { target: string }[] } | undefined;
    const built = new Set((matrix?.include ?? []).map((entry) => entry.target));
    expect(built.size, "the release matrix builds nothing").toBeGreaterThan(4);

    for (const target of [
      "aarch64-apple-darwin", "x86_64-apple-darwin",
      "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu",
      "aarch64-pc-windows-msvc", "x86_64-pc-windows-msvc",
    ]) {
      expect(built, `the launcher downloads ${target} and no job builds it`).toContain(target);
    }
  });

  it("checks the two lists against each other before publishing", () => {
    // The step that resolves through the launcher runs on ubuntu, so it only
    // ever exercises linux-x64. Without a list comparison, a platform no runner
    // here happens to be is a platform nothing checks.
    const steps = release.jobs?.verify?.steps ?? [];
    const comparison = steps.find((step) => (step.run ?? "").includes("does not contain"));
    expect(comparison, "nothing compares what was built against what the launcher offers").toBeDefined();
  });
});
