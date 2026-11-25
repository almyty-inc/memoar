// Synthetic SQLite stores for the rich fixtures, one per database-backed tool,
// written to each tool's real schema. Every string is invented.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { PNG } from "./rich-transcripts.mjs";

const AT = "2026-08-20T09:00:00.000Z";
const MS = 1755680400000;

function database(write) {
  const directory = mkdtempSync(join(tmpdir(), "memoar-rich-"));
  const path = join(directory, "native.sqlite3");
  try {
    const db = new DatabaseSync(path);
    write(db);
    db.close();
    return readFileSync(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function zed() {
  const thread = {
    title: "Zed importer thread",
    version: "0.3.0",
    updated_at: AT,
    detailed_summary: "Detailed summary Zed wrote of the importer thread.",
    messages: [
      { User: { id: "zed-user-1", content: [
        { Text: "Why does the Zed importer lose tool results?" },
        { Mention: { uri: { File: { abs_path: "/workspace/rich/zed.ts" } }, content: "Mentioned file content sent along with the prompt." } },
        { Image: { source: PNG, size: { width: 1, height: 1 } } },
      ] } },
      { Agent: {
        content: [
          { Thinking: { text: "Tool results live in a map beside the content.", signature: "WmVkU2lnbmF0dXJlRm9yVGhlRml4dHVyZQ==" } },
          { RedactedThinking: "WmVkUmVkYWN0ZWRSZWFzb25pbmdQYXlsb2Fk" },
          { ToolUse: { id: "zed-call-1", name: "read_file", raw_input: "{\"path\":\"zed.ts\"}", input: { path: "zed.ts" }, is_input_complete: true } },
          { Text: "The importer never read tool_results; it does now." },
        ],
        tool_results: { "zed-call-1": { tool_use_id: "zed-call-1", tool_name: "read_file", is_error: false, content: { Text: "fn tool_results() -> Map { unread_by_importer() }" }, output: { lines: 1 } } },
      } },
    ],
  };
  return database((db) => {
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL, data_type TEXT NOT NULL, data BLOB NOT NULL, parent_id TEXT, folder_paths TEXT, folder_paths_order TEXT, created_at TEXT)");
    db.prepare("INSERT INTO threads (id, summary, updated_at, data_type, data) VALUES (?, ?, ?, 'zstd', ?)")
      .run("rich-zed-thread", "Zed importer thread", AT, zstdCompressSync(Buffer.from(JSON.stringify(thread))));
  });
}

function opencode() {
  const parts = [
    ["prt_rich01", "msg_rich01", { type: "text", text: "Make the opencode importer keep failed tool calls." }],
    ["prt_rich02", "msg_rich01", { type: "file", mime: "image/png", filename: "screenshot.png", url: `data:image/png;base64,${PNG}` }],
    ["prt_rich03", "msg_rich02", { type: "step-start" }],
    ["prt_rich04", "msg_rich02", { type: "reasoning", text: "A failed call keeps its error under state.error.", metadata: { openai: { reasoningEncryptedContent: "T3BlbmNvZGVFbmNyeXB0ZWRSZWFzb25pbmc=" } } }],
    ["prt_rich05", "msg_rich02", { type: "tool", tool: "bash", callID: "call_rich_bash", state: { status: "completed", input: { command: "npm test -- opencode" }, output: "2 opencode importer tests passed", title: "Run the opencode tests", metadata: { exit: 0 } } }],
    ["prt_rich06", "msg_rich02", { type: "tool", tool: "read", callID: "call_rich_read", state: { status: "error", input: { filePath: "/workspace/rich/gone.ts" }, error: "File not found: the opencode importer path is wrong" } }],
    ["prt_rich07", "msg_rich02", { type: "patch", hash: "abc123", files: ["/workspace/rich/opencode.ts"] }],
    ["prt_rich08", "msg_rich02", { type: "text", text: "Failed calls are archived with their error now." }],
    ["prt_rich09", "msg_rich02", { type: "step-finish", reason: "stop", tokens: { input: 1, output: 1 } }],
  ];
  return database((db) => {
    db.exec("CREATE TABLE `session` (`id` text PRIMARY KEY, `project_id` text NOT NULL, `parent_id` text, `slug` text NOT NULL, `directory` text NOT NULL, `title` text NOT NULL, `version` text NOT NULL)");
    db.exec("CREATE TABLE `message` (`id` text PRIMARY KEY, `session_id` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL)");
    db.exec("CREATE TABLE `part` (`id` text PRIMARY KEY, `message_id` text NOT NULL, `session_id` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL)");
    db.prepare("INSERT INTO session VALUES (?, ?, NULL, ?, ?, ?, ?)").run("ses_rich", "proj_rich", "rich", "/workspace/rich", "Opencode importer", "1.0.0");
    const message = db.prepare("INSERT INTO message VALUES (?, 'ses_rich', ?, ?, ?)");
    message.run("msg_rich01", MS, MS, JSON.stringify({ role: "user" }));
    message.run("msg_rich02", MS + 1, MS + 1, JSON.stringify({ role: "assistant", parentID: "msg_rich01", modelID: "vendor-model", tokens: { input: 5, output: 7 } }));
    const part = db.prepare("INSERT INTO part VALUES (?, ?, 'ses_rich', ?, ?, ?)");
    parts.forEach(([id, messageId, data], index) => part.run(id, messageId, MS + index, MS + index, JSON.stringify(data)));
  });
}

function goose() {
  const rows = [
    ["user", [{ type: "text", text: "Why does the goose importer lose tool arguments?" }, { type: "image", data: PNG, mimeType: "image/png" }]],
    ["assistant", [
      { type: "thinking", thinking: "Goose nests the call under toolCall.value.", signature: "R29vc2VTaWduYXR1cmVGaXh0dXJl" },
      { type: "redactedThinking", data: "R29vc2VSZWRhY3RlZFBheWxvYWQ=" },
      { type: "toolRequest", id: "goose-call-1", toolCall: { status: "success", value: { name: "developer__shell", arguments: { command: "rg toolCall src/goose" } } } },
    ]],
    ["user", [{ type: "toolResponse", id: "goose-call-1", toolResult: { status: "success", value: [{ type: "text", text: "src/goose.ts: name read from the wrong level" }] } }]],
    ["assistant", [{ type: "text", text: "The goose importer reads nested tool calls now." }, { type: "contextLengthExceeded", msg: "Context limit reached; goose summarised the history." }]],
  ];
  return database((db) => {
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', working_dir TEXT NOT NULL, created_at TIMESTAMP)");
    db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, session_id TEXT NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL)");
    db.prepare("INSERT INTO sessions (id, name, description, working_dir, created_at) VALUES (?, ?, ?, ?, ?)").run("rich-goose", "rich", "Goose importer", "/workspace/rich", AT);
    const insert = db.prepare("INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp) VALUES (?, 'rich-goose', ?, ?, ?)");
    rows.forEach(([role, content], index) => insert.run(`goose-msg-${index + 1}`, role, JSON.stringify(content), 1755680400 + index));
  });
}

function crush() {
  const rows = [
    ["user", [{ type: "text", data: { text: "Why does the crush importer show empty messages?" } }, { type: "binary", data: { path: "/workspace/rich/spec.pdf", mime_type: "application/pdf", data: "Q3J1c2hCaW5hcnlBdHRhY2htZW50" } }]],
    ["assistant", [
      { type: "reasoning", data: { thinking: "Crush wraps every part as type plus data.", signature: "Q3J1c2hTaWduYXR1cmU=" } },
      { type: "tool_call", data: { id: "crush-call-1", name: "view", input: "{\"file_path\":\"crush.go\"}", type: "function", finished: true } },
      { type: "finish", data: { reason: "tool_use", time: 1755680401 } },
    ]],
    ["tool", [{ type: "tool_result", data: { tool_call_id: "crush-call-1", name: "view", content: "func marshallParts() wraps parts for the crush importer", metadata: "", is_error: false } }]],
    ["assistant", [{ type: "text", data: { text: "The importer unwraps crush parts now." } }, { type: "image_url", data: { url: "https://example.invalid/crush.png", detail: "low" } }]],
  ];
  return database((db) => {
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL)");
    db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL DEFAULT '[]', model TEXT, created_at INTEGER NOT NULL)");
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("rich-crush", "Crush importer", MS);
    const insert = db.prepare("INSERT INTO messages VALUES (?, 'rich-crush', ?, ?, ?, ?)");
    rows.forEach(([role, parts], index) => insert.run(`crush-msg-${index + 1}`, role, JSON.stringify(parts), role === "assistant" ? "vendor-model" : null, MS + index));
  });
}

function cursor() {
  const composer = "rich-cursor-composer";
  const bubbles = [
    ["b1", { type: 1, text: "Why does the cursor importer drop agent tool calls?", images: [{ path: "/workspace/rich/.cursor/image-1.png", dimension: { width: 1, height: 1 } }] }],
    ["b2", { type: 2, text: "", thinking: { text: "Agent tool calls live in toolFormerData.", signature: "Q3Vyc29yU2lnbmF0dXJl" },
      toolFormerData: { name: "read_file", toolCallId: "cursor-call-1", rawArgs: "{\"target_file\":\"cursor.ts\"}", status: "completed", result: "{\"contents\":\"export const toolFormerData = unread;\"}" } }],
    ["b3", { type: 2, text: "The cursor importer reads toolFormerData now.", allThinkingBlocks: [{ text: "Checked the bubble keys for the agent call." }] }],
  ];
  return database((db) => {
    db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    db.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    insert.run(`composerData:${composer}`, JSON.stringify({ composerId: composer, name: "Cursor importer", createdAt: MS, fullConversationHeadersOnly: bubbles.map(([bubbleId, bubble]) => ({ bubbleId, type: bubble.type })) }));
    for (const [bubbleId, bubble] of bubbles) insert.run(`bubbleId:${composer}:${bubbleId}`, JSON.stringify({ bubbleId, ...bubble }));
  });
}

/** SQLite rich fixtures: [source, version, input file name, bytes]. */
export function richStoreInputs() {
  return [
    ["zed", "v1", "native.sqlite3", zed()],
    ["opencode", "v1", "native.sqlite3", opencode()],
    ["goose", "v1", "native.sqlite3", goose()],
    ["crush", "v1", "native.sqlite3", crush()],
    ["cursor", "v3", "native.sqlite3", cursor()],
  ];
}
