import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const fixturesRoot = resolve(root, "contracts/fixtures");
const contractVersion = JSON.parse(await readFile(resolve(root, "contracts/source/canonical.model.json"), "utf8")).contractVersion;

const tierOne = ["claude-code", "codex", "antigravity-cli", "cursor"];
const otherSources = [
  "opencode",
  "copilot",
  "goose",
  "crush",
  "roo",
  "kilo",
  "zed",
  "chatgpt-export",
  "cass-export",
  "canonical-bundle"
];

const fixtures = [];
for (const source of tierOne) {
  for (let index = 1; index <= 3; index += 1) fixtures.push({ source, version: versionFor(source), index });
}
for (const source of otherSources) fixtures.push({ source, version: versionFor(source), index: 1 });

const manifest = [];
for (const [position, fixture] of fixtures.entries()) {
  const slug = `session-${fixture.index}`;
  const directory = resolve(fixturesRoot, fixture.source, fixture.version, slug);
  const inputDirectory = resolve(directory, "input");
  await mkdir(inputDirectory, { recursive: true });
  const inputName = inputNameFor(fixture.source);
  const inputPath = resolve(inputDirectory, inputName);
  const expectedPath = resolve(directory, "expected.canonical.json");

  // A fixture that exists is never regenerated.
  //
  // This script invents an input by working backwards from a canonical session,
  // which is how the corpus came to describe shapes no tool writes: the
  // generated input and the parser were derived from the same assumption, so
  // every fixture passed while no parser could read a real file. The inputs
  // here are now built from real schemas and real installs. Delete one
  // deliberately if you mean to replace it.
  if (existsSync(inputPath) && existsSync(expectedPath)) {
    console.log(`kept: ${fixture.source}/${fixture.version}/${slug}`);
    manifest.push({
      source: fixture.source,
      version: fixture.version,
      fixture: slug,
      input: relative(root, inputPath),
      inputSha256: createHash("sha256").update(await readFile(inputPath)).digest("hex"),
      expected: relative(root, expectedPath)
    });
    continue;
  }

  const canonical = makeCanonical(fixture, position + 1);
  const inputValue = nativeInput(fixture, canonical);
  const inputBytes = typeof inputValue === "string" ? Buffer.from(inputValue, "utf8") : Buffer.from(inputValue);
  await writeFile(inputPath, inputBytes);
  await writeFile(expectedPath, `${JSON.stringify(canonical, null, 2)}\n`);
  manifest.push({
    source: fixture.source,
    version: fixture.version,
    fixture: slug,
    input: relative(root, inputPath),
    inputSha256: createHash("sha256").update(inputBytes).digest("hex"),
    expected: relative(root, expectedPath)
  });
}
await writeFile(resolve(fixturesRoot, "manifest.json"), `${JSON.stringify({ version: contractVersion, fixtures: manifest }, null, 2)}\n`);
console.log(`generated ${manifest.length} scrubbed fixtures`);

function versionFor(source) {
  if (source === "codex") return "rollout-v1";
  if (source === "cursor") return "v3";
  if (source.endsWith("export")) return "2026-08";
  return "v1";
}

/** The file each tool actually writes, matching the fixtures on disk. */
function inputNameFor(source) {
  if (["cursor", "goose", "crush", "zed", "opencode", "copilot"].includes(source)) return "native.sqlite3";
  if (["claude-code", "codex"].includes(source)) return "session.jsonl";
  if (source === "antigravity-cli") return "transcript.jsonl";
  if (["roo", "kilo"].includes(source)) return "task.json";
  if (source === "cass-export") return "cass.json";
  if (source === "canonical-bundle") return "bundle.json";
  if (source.endsWith("export")) return "export.zip";
  throw new Error(`no input file name is defined for ${source}`);
}

function makeCanonical(fixture, index) {
  const sessionId = uuid(index * 10);
  const firstTurnId = uuid(index * 10 + 1);
  const secondTurnId = uuid(index * 10 + 2);
  const createdAt = `2026-08-${String((index % 15) + 1).padStart(2, "0")}T09:00:00.000Z`;
  return {
    id: sessionId,
    source: {
      vendor: vendorFor(fixture.source),
      tool: fixture.source,
      version: fixture.version,
      machineId: "0191cafe-0000-7000-8000-000000000001",
      nativeSessionId: `${fixture.source}-${fixture.index}`
    },
    workspace: {
      path: `/workspace/example-${fixture.index}`,
      gitRemote: "https://example.invalid/acme/memoar-fixture.git",
      branch: "main"
    },
    createdAt,
    updatedAt: createdAt,
    title: `${displayName(fixture.source)} fixture ${fixture.index}`,
    summary: "Scrubbed session used to verify canonical normalization.",
    models: [modelFor(fixture.source)],
    tokenTotals: { input: 34 + index, output: 55 + index, cacheRead: 0, cacheWrite: 0 },
    provenance: [{
      kind: fixture.source.endsWith("export") || fixture.source === "canonical-bundle" ? "import" : "native",
      sourceId: `${fixture.source}:${fixture.version}:${fixture.index}`,
      capturedAt: createdAt,
      parserVersion: contractVersion,
      details: { fixture: true }
    }],
    visibility: {
      scope: "private",
      ownerId: "0191cafe-0000-7000-8000-000000000002"
    },
    turns: [
      {
        id: firstTurnId,
        ordinal: 0,
        parentId: null,
        role: "user",
        createdAt,
        blocks: [{ id: uuid(index * 10 + 3), kind: "text", text: "Find the cause of the failing archive test." }]
      },
      {
        id: secondTurnId,
        ordinal: 1,
        parentId: firstTurnId,
        role: "assistant",
        createdAt,
        model: modelFor(fixture.source),
        tokens: { input: 34 + index, output: 55 + index },
        blocks: [
          { id: uuid(index * 10 + 4), kind: "thinking", text: "I will inspect the parser boundary and the fixture." },
          { id: uuid(index * 10 + 5), kind: "tool_call", name: "read_file", callId: `fixture-call-${index}`, data: { path: "src/archive.ts" } },
          { id: uuid(index * 10 + 6), kind: "text", text: "The parser dropped parent references. Preserve the native parent id during normalization." }
        ]
      }
    ],
    ext: { fixtureSource: fixture.source }
  };
}

function nativeInput(fixture, canonical) {
  const user = canonical.turns[0];
  const assistant = canonical.turns[1];
  const historyEntries = canonical.turns.map((turn) => ({
    id: turn.id, role: turn.role, at: turn.createdAt, parentId: turn.parentId, parts: turn.blocks
  }));
  if (["cursor", "goose", "crush", "zed", "opencode", "copilot"].includes(fixture.source)) return sqliteInput(fixture.source, canonical);
  if (fixture.source === "pi-agent") {
    return [
      { type: "event", event: "session_start", at: canonical.createdAt, sessionId: canonical.source.nativeSessionId, workspace: canonical.workspace.path },
      { type: "event", event: "message", id: user.id, role: "user", at: user.createdAt, payload: { parts: user.blocks } },
      { type: "event", event: "message", id: assistant.id, role: "assistant", parentId: user.id, at: assistant.createdAt, payload: { parts: assistant.blocks } }
    ].map((value) => JSON.stringify(value)).join("\n") + "\n";
  }
  if (["roo", "kilo"].includes(fixture.source)) {
    return `${JSON.stringify({
      taskId: canonical.source.nativeSessionId,
      title: canonical.title,
      createdAt: canonical.createdAt,
      workspace: canonical.workspace.path,
      history: historyEntries
    }, null, 2)}\n`;
  }
  if (fixture.source === "amp") {
    return `${JSON.stringify({
      threads: [{
        id: canonical.source.nativeSessionId,
        title: canonical.title,
        createdAt: canonical.createdAt,
        messages: historyEntries
      }]
    }, null, 2)}\n`;
  }
  if (fixture.source === "cass-export") {
    return `${JSON.stringify({
      cassVersion: 1,
      exportedAt: canonical.createdAt,
      sessions: [{
        id: canonical.source.nativeSessionId,
        agent: "cass",
        workspace: canonical.workspace.path,
        title: canonical.title,
        messages: historyEntries
      }]
    }, null, 2)}\n`;
  }
  if (fixture.source === "canonical-bundle") {
    return `${JSON.stringify({ memoarBundle: contractVersion, sessions: [canonical] }, null, 2)}\n`;
  }
  if (fixture.source === "claude-code") {
    return [
      { uuid: user.id, parentUuid: null, type: "user", message: { role: "user", content: user.blocks[0].text }, timestamp: user.createdAt },
      { uuid: assistant.id, parentUuid: user.id, type: "assistant", message: { role: "assistant", model: assistant.model, content: assistant.blocks }, timestamp: assistant.createdAt }
    ].map((value) => JSON.stringify(value)).join("\n") + "\n";
  }
  if (fixture.source === "codex") {
    return [
      { timestamp: canonical.createdAt, type: "session_meta", payload: { id: canonical.id, cwd: canonical.workspace.path, source: "cli" } },
      { timestamp: user.createdAt, type: "response_item", payload: { role: "user", content: user.blocks } },
      { timestamp: assistant.createdAt, type: "response_item", payload: { role: "assistant", content: assistant.blocks } }
    ].map((value) => JSON.stringify(value)).join("\n") + "\n";
  }
  if (fixture.source === "antigravity-cli") {
    return [
      { type: "message", id: user.id, role: "user", parts: user.blocks, createdAt: user.createdAt },
      { type: "message", id: assistant.id, parentId: user.id, role: "assistant", parts: assistant.blocks, createdAt: assistant.createdAt }
    ].map((value) => JSON.stringify(value)).join("\n") + "\n";
  }
  if (fixture.source.endsWith("export")) {
    const entryName = fixture.source === "gemini-export" ? "Gemini/conversations.json" : "conversations.json";
    const exported = fixture.source === "chatgpt-export" ? [{ id: canonical.id, title: canonical.title, mapping: {
      [user.id]: { id: user.id, parent: null, children: [assistant.id], message: { author: { role: "user" }, content: { parts: [user.blocks[0].text] } } },
      [assistant.id]: { id: assistant.id, parent: user.id, children: [], message: { author: { role: "assistant" }, content: { parts: [assistant.blocks.at(-1).text] } } }
    }}] : [{ uuid: canonical.id, name: canonical.title, messages: canonical.turns }];
    return zipSync({ [entryName]: strToU8(`${JSON.stringify(exported, null, 2)}\n`) }, { level: 0 });
  }
  return `${JSON.stringify({ source: fixture.source, version: fixture.version, session: canonical }, null, 2)}\n`;
}

function uuid(value) {
  const hex = value.toString(16).padStart(12, "0");
  return `0191cafe-0000-7000-8000-${hex}`;
}

function vendorFor(source) {
  if (["claude-code", "claude-ai-export"].includes(source)) return "anthropic";
  if (["codex", "chatgpt-export", "copilot"].includes(source)) return source === "copilot" ? "github" : "openai";
  if (["antigravity-cli", "antigravity-ide", "gemini-export"].includes(source)) return "google";
  if (source === "canonical-bundle") return "memoar";
  if (source === "windsurf") return "codeium";
  if (source === "amp") return "sourcegraph";
  return source.split("-")[0];
}

function modelFor(source) {
  if (source.includes("claude")) return "claude-sonnet";
  if (source === "codex" || source === "chatgpt-export") return "gpt-5";
  if (source.includes("antigravity") || source.includes("gemini")) return "gemini-pro";
  return "vendor-model";
}

function displayName(source) {
  return source.split("-").map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(" ");
}

function sqliteInput(source, canonical) {
  const directory = mkdtempSync(join(tmpdir(), "memoar-fixture-"));
  const path = join(directory, "native.sqlite3");
  try {
    const database = new DatabaseSync(path);
    if (source === "cursor") writeCursorDatabase(database, canonical);
    else if (source === "goose") writeGooseDatabase(database, canonical);
    else if (source === "crush") writeCrushDatabase(database, canonical);
    else if (source === "zed") writeZedDatabase(database, canonical);
    else if (source === "antigravity-cli" || source === "antigravity-ide") writeAntigravityDatabase(database, canonical);
    else if (source === "warp") writeWarpDatabase(database, canonical);
    else if (source === "windsurf") writeWindsurfDatabase(database, canonical);
    else throw new Error(`no sqlite writer for ${source}`);
    database.close();
    return readFileSync(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeCursorDatabase(database, canonical) {
  database.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
  const conversation = canonical.turns.map((turn) => ({
    bubbleId: turn.id,
    parentBubbleId: turn.parentId,
    role: turn.role,
    createdAt: turn.createdAt,
    blocks: turn.blocks
  }));
  const payload = JSON.stringify({
    composerId: canonical.source.nativeSessionId,
    name: canonical.title,
    createdAt: canonical.createdAt,
    conversation
  });
  database
    .prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)")
    .run(`composerData:${canonical.source.nativeSessionId}`, payload);
}

function writeGooseDatabase(database, canonical) {
  database.exec(
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, description TEXT, working_dir TEXT, created_at TEXT);
     CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, parent_id TEXT, role TEXT NOT NULL, created_at TEXT NOT NULL, content TEXT NOT NULL);`
  );
  database
    .prepare("INSERT INTO sessions (id, description, working_dir, created_at) VALUES (?, ?, ?, ?)")
    .run(canonical.source.nativeSessionId, canonical.title, canonical.workspace.path, canonical.createdAt);
  const insert = database.prepare(
    "INSERT INTO messages (id, session_id, ordinal, parent_id, role, created_at, content) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  for (const turn of canonical.turns) {
    insert.run(turn.id, canonical.source.nativeSessionId, turn.ordinal, turn.parentId, turn.role, turn.createdAt, JSON.stringify(turn.blocks));
  }
}

function writeCrushDatabase(database, canonical) {
  database.exec(
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
     CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, parent_id TEXT, role TEXT NOT NULL, parts TEXT NOT NULL, created_at TEXT NOT NULL);`
  );
  database
    .prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(canonical.source.nativeSessionId, canonical.title, canonical.createdAt, canonical.updatedAt);
  const insert = database.prepare(
    "INSERT INTO messages (id, session_id, ordinal, parent_id, role, parts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  for (const turn of canonical.turns) {
    insert.run(turn.id, canonical.source.nativeSessionId, turn.ordinal, turn.parentId, turn.role, JSON.stringify(turn.blocks), turn.createdAt);
  }
}

function writeZedDatabase(database, canonical) {
  database.exec(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT, updated_at TEXT, data_type TEXT NOT NULL, data BLOB NOT NULL)"
  );
  const thread = {
    version: 1,
    messages: canonical.turns.map((turn) => ({
      id: turn.id,
      parentId: turn.parentId,
      role: turn.role,
      createdAt: turn.createdAt,
      segments: turn.blocks
    }))
  };
  const compressed = zstdCompressSync(Buffer.from(JSON.stringify(thread), "utf8"));
  database
    .prepare("INSERT INTO threads (id, summary, updated_at, data_type, data) VALUES (?, ?, ?, 'zstd', ?)")
    .run(canonical.source.nativeSessionId, canonical.title, canonical.updatedAt, compressed);
}

function writeAntigravityDatabase(database, canonical) {
  database.exec(
    `PRAGMA user_version = 1;
     CREATE TABLE trajectory_meta (
       trajectory_id TEXT PRIMARY KEY,
       cascade_id TEXT,
       trajectory_type INTEGER,
       source INTEGER
     );
     CREATE TABLE steps (
       idx INTEGER PRIMARY KEY,
       step_type INTEGER DEFAULT 0,
       status INTEGER DEFAULT 0,
       has_subtrajectory NUMERIC DEFAULT 0,
       metadata BLOB,
       error_details BLOB,
       permissions BLOB,
       task_details BLOB,
       render_info BLOB,
       step_payload BLOB,
       step_format INTEGER DEFAULT 0
     );
     CREATE INDEX idx_steps_status ON steps(status);
     CREATE INDEX idx_steps_step_type ON steps(step_type);`
  );
  database
    .prepare("INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, 0, 0)")
    .run(canonical.source.nativeSessionId, canonical.source.nativeSessionId);
  const insert = database.prepare("INSERT INTO steps (idx, step_type, status, step_payload, step_format) VALUES (?, 0, 2, ?, 1)");
  for (const turn of canonical.turns) {
    const payload = JSON.stringify({
      id: turn.id,
      parentId: turn.parentId,
      role: turn.role,
      createdAt: turn.createdAt,
      parts: turn.blocks
    });
    insert.run(turn.ordinal, Buffer.from(payload, "utf8"));
  }
}

function writeWarpDatabase(database, canonical) {
  database.exec(
    "CREATE TABLE agent_conversations (conversation_id TEXT PRIMARY KEY, conversation_data TEXT NOT NULL, last_modified_at TEXT NOT NULL)"
  );
  const conversation = {
    id: canonical.source.nativeSessionId,
    title: canonical.title,
    createdAt: canonical.createdAt,
    messages: canonical.turns.map((turn) => ({
      id: turn.id, role: turn.role, at: turn.createdAt, parentId: turn.parentId, parts: turn.blocks
    }))
  };
  database
    .prepare("INSERT INTO agent_conversations (conversation_id, conversation_data, last_modified_at) VALUES (?, ?, ?)")
    .run(canonical.source.nativeSessionId, JSON.stringify(conversation), canonical.updatedAt);
}

function writeWindsurfDatabase(database, canonical) {
  database.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  const state = {
    conversations: [{
      id: canonical.source.nativeSessionId,
      title: canonical.title,
      createdAt: canonical.createdAt,
      messages: canonical.turns.map((turn) => ({
        id: turn.id, role: turn.role, at: turn.createdAt, parentId: turn.parentId, parts: turn.blocks
      }))
    }]
  };
  database
    .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
    .run("windsurf.cascadeState", JSON.stringify(state));
}