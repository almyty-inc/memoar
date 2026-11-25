/*
  No capture pattern may name a key, a credential store or a repository's
  internals unless the agent's deny list refuses it.

  This is the half of the capture/parser agreement that file extensions cannot
  see. `.claude.json` is JSON, `.audit-key` has no extension a pattern would
  ever name, and `.git/sess.jsonl` ends in `.jsonl`. All three reached the dev
  archive, along with `.git/index` and `.DS_Store`, from patterns that were
  bare directories at the time.

  So every wildcard in every pattern is filled with each sample below that it
  can match, and the resulting path is run through a port of
  `is_denied` (agent/crates/memoar-connectors/src/deny.rs) fed with the tables
  read out of that file. A sample the pattern can reach and the list does not
  refuse is a failure. The samples live here, not in deny.rs, so deleting an
  entry there cannot also delete the test of it.
*/

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** File names that must never be uploaded, whatever directory holds them. */
const SECRET_FILE_SAMPLES = [
  '.audit-key', '.claude.json', '.claude.json.backup.1700000000000', '.credentials.json',
  'credentials.json', '.DS_Store', '.env', '.env.local', '.netrc', '.npmrc', '.pypirc',
  '.git-credentials', 'id_rsa', 'id_ed25519', 'id_ed25519.pub', 'server.key', 'server.pem',
  'client.p12',
];

/** Directories whose contents must never be uploaded. */
const SECRET_DIRECTORY_SAMPLES = ['.git', '.hg', '.svn', '.ssh', '.gnupg', '.aws'];

/** `*` within one segment, as `matches_segment` in memory.rs does it. */
export function matchesSegment(pattern, name) {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === name;
  if (!name.startsWith(parts[0])) return false;
  const rest = name.slice(parts[0].length);
  const last = parts.at(-1);
  if (rest.length < last.length || !rest.endsWith(last)) return false;
  let remaining = rest.slice(0, rest.length - last.length);
  for (const middle of parts.slice(1, -1)) {
    const index = remaining.indexOf(middle);
    if (index === -1) return false;
    remaining = remaining.slice(index + middle.length);
  }
  return true;
}

/** The three tables of deny.rs, read rather than repeated. */
export async function denyTables(root) {
  const text = await readFile(resolve(root, 'agent/crates/memoar-connectors/src/deny.rs'), 'utf8');
  const table = (name) => {
    const body = new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`, 'u').exec(text)?.[1];
    if (body === undefined) throw new Error(`deny.rs has no ${name} table; has its shape changed?`);
    return [...body.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  };
  return {
    directories: table('DENIED_DIRECTORIES'),
    names: table('DENIED_NAMES'),
    patterns: table('DENIED_PATTERNS'),
  };
}

/** `is_denied`, over the segments below a pattern's fixed root. */
export function isDenied(tables, segments) {
  const file = segments.at(-1);
  return segments.slice(0, -1).some((directory) => tables.directories.includes(directory))
    || tables.directories.includes(file)
    || tables.names.includes(file)
    || tables.patterns.some((pattern) => matchesSegment(pattern, file));
}

/** A concrete name a wildcard segment accepts, for the segments not under test. */
const filler = (segment) => segment.replaceAll('*', 'x');

/**
 * Every failure for one source's patterns, as sentences.
 *
 * Only segments from the first wildcard on are judged, which is the part a
 * pattern does not fix: `.claude/projects` is named by the pattern itself.
 */
export function deniedPathFailures(tables, id, patterns) {
  const failures = [];
  for (const { pattern } of patterns) {
    if (pattern.includes('**')) {
      failures.push(`${id}: ${pattern} reaches any depth, so what it can collect cannot be bounded. Name each depth.`);
      continue;
    }
    const segments = pattern.split('/');
    const firstWildcard = segments.findIndex((segment) => segment.includes('*'));
    if (firstWildcard === -1) continue;
    segments.forEach((segment, index) => {
      if (!segment.includes('*')) return;
      const isFile = index === segments.length - 1;
      const samples = (isFile ? SECRET_FILE_SAMPLES : SECRET_DIRECTORY_SAMPLES).filter((sample) => matchesSegment(segment, sample));
      for (const sample of samples) {
        const filled = segments.map((part, at) => (at === index ? sample : filler(part)));
        if (!isDenied(tables, filled.slice(firstWildcard))) {
          failures.push(
            `${id}: ${pattern} can collect ${filled.slice(firstWildcard).join('/')}, and the deny list in`
            + ' agent/crates/memoar-connectors/src/deny.rs does not refuse it. Narrow the pattern or extend the list.',
          );
        }
      }
    });
  }
  return failures;
}
