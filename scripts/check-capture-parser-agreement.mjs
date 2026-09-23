#!/usr/bin/env node
/*
  Every file a capture pattern names must be a file its parser can open.

  The agent and the parsers are two halves of one product written in two
  languages, and nothing compared the *shapes* they trade in. `zed` was pointed
  at `db/<channel>/db.sqlite`, the editor's own panes and terminals, while its
  parser reads one table that only `threads/threads.db` has. `opencode`
  collected the JSON under `storage/`, its configuration, while its parser
  refuses anything that is not native SQLite. Each archived the wrong bytes for
  as long as its pattern stood, and the tests agreed the whole time, because the
  tests named the wrong file too.

  This is that comparison, mechanically: the extension a pattern names against
  the bytes the parser will accept. It cannot tell a transcript from a settings
  file — only a person with the tool installed can, which is what
  scripts/verify-parsers-locally.mjs is for — but it does catch a pattern
  spending a user's bandwidth on bytes that can only come back `unknown_format`.

  A known mismatch is not deleted, it is declared. `contracts/fixtures/
  PROVENANCE.md` explains why: raw bytes are kept so a parser written later can
  still read them. So every mismatch must appear in UNSETTLED below with what
  would settle it, and a mismatch that is not declared — or a declaration with
  no mismatch left — fails this check.
*/

import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONNECTOR_SRC = resolve(root, 'agent/crates/memoar-connectors/src');
const PARSER_SRC = resolve(root, 'server/libs/parsers/src');

/*
  The mismatches that are known, deliberate and still open.

  Each one is bytes collected today that the server can only refuse. They stay
  because nobody here runs the tool, and guessing a different pattern would
  replace a known-wrong answer with an unknown one. `settledBy` is the task,
  written so somebody with the tool installed can finish it.
*/
const UNSETTLED = [
  {
    source: 'goose',
    pattern: 'sessions/*.jsonl',
    settledBy: 'The source is declared "SQLite or legacy JSONL" and the parser implements only the SQLite half. Install block-goose-cli, hold one session, and list the session directory: if a .jsonl is still written it needs a parser branch, and if none is, the pattern goes. Declared once for both the common and the Windows path. Checked again 2026-09-23 and there is still nothing here to ask: goose is not on PATH, and neither ~/.local/share/goose nor ~/Library/Application Support/Block exists.',
  },
];

/** What the bytes behind a path look like, by the name the pattern gives it. */
const SHAPE_BY_EXTENSION = {
  db: 'sqlite',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  vscdb: 'sqlite',
  jsonl: 'jsonl',
  json: 'json',
  md: 'text',
  txt: 'text',
  log: 'text',
  yaml: 'text',
  yml: 'text',
};

const failures = [];

/** Rust line comments, removed so a sentence cannot look like a path. */
function withoutComments(text) {
  return text.replace(/^\s*\/\/.*$/gmu, '');
}

/** The connector table, found by searching rather than by a filename. */
async function connectorSources() {
  const entries = await readdir(CONNECTOR_SRC, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.rs'));
  const texts = await Promise.all(files.map((entry) => readFile(resolve(CONNECTOR_SRC, entry.name), 'utf8')));
  const table = texts.filter((text) => text.includes('SourceSpec {')).join('\n');
  if (!table) {
    throw new Error(`no SourceSpec table under ${CONNECTOR_SRC}; has the connector table been deleted?`);
  }

  const sources = [];
  for (const chunk of withoutComments(table).split('SourceSpec {').slice(1)) {
    const id = /id:\s*"([a-z0-9-]+)"/u.exec(chunk)?.[1];
    if (!id) continue;
    const patterns = [];
    for (const field of chunk.matchAll(/(common|linux|macos|windows)_paths:\s*&\[([\s\S]*?)\]/gu)) {
      for (const literal of field[2].matchAll(/"([^"]+)"/gu)) {
        patterns.push({ platform: field[1], pattern: literal[1] });
      }
    }
    sources.push({ id, patterns });
  }
  if (sources.length === 0) throw new Error('the SourceSpec table parsed to no sources; has its shape changed?');
  return sources;
}

/**
 * The bytes each parser will accept, read off the parser's own guards.
 *
 * `!isSqliteBytes` is a refusal of everything else and says so; a bare
 * `isSqliteBytes` is a branch with a fallback behind it. The readers are named
 * as constants so the failure below can say what it looked for.
 *
 * A parser that starts reading JSON lines through some third function will read
 * as accepting nothing, and the message has to be enough to act on —
 * `parseJsonLines` was renamed to `readJsonLines` in one parser and this check
 * went red saying only "have its guards changed?", which is a true statement
 * that tells you nothing about what to do.
 */
const JSON_LINE_READERS = /\b(?:parse|read)JsonLines\(/u;
const WHOLE_JSON_READER = /JSON\.parse\(Buffer\.from\(request\.raw\)/u;

function acceptedShapes(text) {
  const shapes = new Set();
  if (/isSqliteBytes\(/u.test(text)) shapes.add('sqlite');
  if (/!isSqliteBytes\(/u.test(text)) return shapes;
  if (JSON_LINE_READERS.test(text)) shapes.add('jsonl');
  if (WHOLE_JSON_READER.test(text)) shapes.add('json');
  return shapes;
}

/** source id -> the shapes its parser accepts. */
async function parserShapes() {
  const entries = await readdir(PARSER_SRC, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'));
  const texts = new Map();
  for (const entry of files) texts.set(entry.name, await readFile(resolve(PARSER_SRC, entry.name), 'utf8'));

  const shapes = new Map();
  for (const [, text] of texts) {
    const declared = /readonly source = "([a-z0-9-]+)"/u.exec(text)?.[1];
    if (declared) shapes.set(declared, acceptedShapes(text));
  }

  // Parsers told their source at construction — kilo and roo share one class.
  const index = texts.get('index.ts') ?? '';
  for (const shared of index.matchAll(/\[([^\]]*)\]\.map\(\(source\) => new (\w+)\(source\)\)/gu)) {
    const ids = [...shared[1].matchAll(/"([a-z0-9-]+)"/gu)].map((match) => match[1]);
    const owner = [...texts.values()].find((text) => text.includes(`class ${shared[2]} `));
    if (!owner) throw new Error(`index.ts constructs ${shared[2]} but no parser file declares it`);
    for (const id of ids) shapes.set(id, acceptedShapes(owner));
  }
  return shapes;
}

/** The shape a pattern promises, by the extension of its last segment. */
function shapeOf(pattern) {
  const name = pattern.split('/').pop() ?? '';
  if (!name.includes('.')) return null;
  return SHAPE_BY_EXTENSION[name.split('.').pop().toLowerCase()] ?? null;
}

const sources = await connectorSources();
const shapes = await parserShapes();
const found = [];

for (const { id, patterns } of sources) {
  const accepted = shapes.get(id);
  if (!accepted) {
    failures.push(`${id}: the agent captures it and no parser declares it`);
    continue;
  }
  if (accepted.size === 0) {
    failures.push(
      `${id}: the parser calls none of the readers this check knows, so what it accepts cannot be told.`
      + ` It looks for ${JSON_LINE_READERS.source} (jsonl), ${WHOLE_JSON_READER.source} (json)`
      + " and isSqliteBytes( (sqlite). If the parser now reads its bytes another way, add that reader here.",
    );
    continue;
  }
  for (const { platform, pattern } of patterns) {
    const shape = shapeOf(pattern);
    if (shape === null) {
      failures.push(`${id}: pattern ${pattern} names no file extension, so what it collects cannot be checked`);
      continue;
    }
    if (!accepted.has(shape)) {
      found.push({ source: id, platform, pattern, shape, accepted: [...accepted].sort().join(', ') });
    }
  }
}

/* A declaration matches a mismatch when it names its tail; patterns carry
   platform prefixes (`Library/Application Support/...`) that a person reading
   PROVENANCE.md does not need repeated. */
const matches = (declared, mismatch) =>
  declared.source === mismatch.source
  && mismatch.pattern.endsWith(declared.pattern)
  && (declared.platform === undefined || declared.platform === mismatch.platform);

const claimed = new Set();
for (const mismatch of found) {
  const index = UNSETTLED.findIndex((declared) => matches(declared, mismatch));
  if (index === -1) {
    failures.push(
      `${mismatch.source}: ${mismatch.pattern} collects ${mismatch.shape}, and its parser accepts only ${mismatch.accepted}.`
      + ' Whatever it matches is uploaded and refused. Fix the pattern, or declare it in UNSETTLED with what would settle it.',
    );
    continue;
  }
  claimed.add(index);
}

// A declaration with nothing left to declare is worse than none: it is a note
// saying a live defect is known, kept after the defect is gone.
UNSETTLED.forEach((declared, at) => {
  if (!claimed.has(at)) {
    failures.push(
      `${declared.source}: ${declared.pattern} is declared as an open mismatch and is not one any more.`
      + ' Delete the declaration, and record in contracts/fixtures/PROVENANCE.md how it was settled.',
    );
  }
});

if (failures.length > 0) {
  console.error('capture patterns disagree with what the parsers accept:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `capture/parser agreement: ${sources.length} sources checked, `
  + `${found.length} declared mismatches still open (see UNSETTLED in ${'scripts/check-capture-parser-agreement.mjs'}).`,
);
