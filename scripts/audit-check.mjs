#!/usr/bin/env node
/**
 * Fails on known vulnerabilities, except ones that have been looked at.
 *
 * `npm audit --audit-level=moderate` is the right gate right up to the moment
 * an advisory lands with no upstream fix. Then it fails every build until
 * somebody either fixes what cannot be fixed or deletes the gate — and deleting
 * the gate is what actually happens, which loses every future advisory too.
 *
 * So an advisory can be acknowledged, in writing, with a reason and a date it
 * must be looked at again. An expired acknowledgement fails the build exactly
 * as an unreviewed advisory does, so this cannot quietly become a permanent
 * exemption list.
 */

import { execFileSync } from "node:child_process";

/**
 * Advisories we have read and decided about.
 *
 * `until` is not a guess about when upstream will fix it. It is when we have to
 * look again.
 *
 * Empty on purpose. The multer entries that used to live here were retired once
 * multer 2.5.0 shipped the fix. Add an entry only for an advisory that has no
 * upstream fix or does not reach this code, and say which in the reason.
 */
const ACKNOWLEDGED = [];

const SEVERITIES = ["moderate", "high", "critical"];

function audit() {
  try {
    return JSON.parse(execFileSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  } catch (error) {
    // npm exits non-zero when it finds anything, and still prints the report.
    const output = (error).stdout;
    if (typeof output === "string" && output.length > 0) return JSON.parse(output);
    throw error;
  }
}

const report = audit();
const today = new Date().toISOString().slice(0, 10);
const failures = [];
const allowed = [];

for (const [name, advisory] of Object.entries(report.vulnerabilities ?? {})) {
  if (!SEVERITIES.includes(advisory.severity)) continue;
  const note = ACKNOWLEDGED.find((entry) => entry.package === name);
  if (!note) {
    failures.push(`${name} (${advisory.severity}) — not acknowledged`);
    continue;
  }
  if (note.until < today) {
    failures.push(`${name} (${advisory.severity}) — acknowledgement expired on ${note.until}, look again`);
    continue;
  }
  allowed.push(`${name} (${advisory.severity}) — acknowledged until ${note.until}`);
}

for (const line of allowed) console.log(`  ok  ${line}`);
for (const line of failures) console.error(`fail  ${line}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} advisory group(s) need attention. Fix them, or acknowledge them in scripts/audit-check.mjs with a reason and a review date.`);
  process.exit(1);
}
console.log(`\nNo unreviewed advisories at moderate or above.`);
