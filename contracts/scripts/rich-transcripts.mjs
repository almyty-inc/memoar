// Synthetic transcripts that exercise every content shape a text-based store
// writes: tool results as a string and as an array with an image, an error
// flag, thinking with a signature, redacted and encrypted reasoning, images,
// documents, and the system, compaction and summary records around them.
//
// Every string here is invented. Nothing is copied from a real session, and
// the shapes are the ones read off real stores by key name only.
import { strToU8, zipSync } from "fflate";

export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
export const PDF = "JVBERi0xLjQKJcfsj6IKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PgplbmRvYmoKdHJhaWxlcgo8PC9Sb290IDEgMCBSPj4KJSVFT0YK";
const AT = "2026-08-20T09:00:00.000Z";
const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
const uuid = (n) => `0191cafe-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function claudeCode() {
  const base = { sessionId: "rich-claude-session", cwd: "/workspace/rich", gitBranch: "main", version: "2.1.0", isSidechain: false, userType: "external" };
  const line = (n, parent, extra) => ({ ...base, uuid: uuid(0xc000 + n), parentUuid: parent === null ? null : uuid(0xc000 + parent), timestamp: AT, ...extra });
  return jsonl([
    { type: "permission-mode", permissionMode: "default", sessionId: base.sessionId },
    line(1, null, { type: "user", message: { role: "user", content: "Please find why the archive importer loses tool output." } }),
    line(2, 1, { type: "assistant", message: { role: "assistant", model: "claude-sonnet", content: [
      { type: "thinking", thinking: "The importer probably copies only the text field of each block.", signature: "RXF1aXZhbGVudFNpZ25hdHVyZUJ5dGVzRm9yVGhlRml4dHVyZQ==" },
      { type: "redacted_thinking", data: "RW5jcnlwdGVkUmVhc29uaW5nUGF5bG9hZEZvclRoZUZpeHR1cmU=" },
      { type: "text", text: "I will read the parser and run the failing test." },
      { type: "tool_use", id: "toolu_rich_read", name: "Read", input: { file_path: "/workspace/rich/src/parser.ts" }, caller: { type: "direct" } },
      { type: "tool_use", id: "toolu_rich_shot", name: "Screenshot", input: { region: "importer panel" } },
    ] } }),
    line(3, 2, { type: "user", toolUseResult: { stdout: "duplicate of the tool result content" }, message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_rich_read", content: "export function parseBlock() { return copyTextOnly(); }" },
      { type: "tool_result", tool_use_id: "toolu_rich_shot", is_error: true, content: [
        { type: "text", text: "The screenshot tool timed out after capturing one frame." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
      ] },
    ] } }),
    line(4, 3, { type: "user", message: { role: "user", content: [
      { type: "text", text: "Here is the design note and a picture of the bug." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
      { type: "document", title: "Importer design note", source: { type: "base64", media_type: "application/pdf", data: PDF } },
      { type: "document", source: { type: "text", media_type: "text/plain", data: "Plain text design note: blocks must keep every field." } },
    ] } }),
    line(5, 4, { type: "system", subtype: "compact_boundary", content: "Conversation compacted to free context", level: "info", compactMetadata: { trigger: "auto", preTokens: 120000 } }),
    line(6, 5, { type: "user", isCompactSummary: true, message: { role: "user", content: "Summary of the earlier conversation: the importer drops tool output." } }),
    line(7, 6, { type: "attachment", attachment: { type: "queued_command", prompt: "Also check whether thinking text survives the import.", commandMode: "prompt" } }),
    line(8, 7, { type: "attachment", attachment: { type: "hook_success", hookName: "PostToolUse", stdout: "hook bookkeeping that is not conversation", content: "", command: "true" } }),
    line(9, 8, { type: "attachment", attachment: { type: "file", filename: "/workspace/rich/notes.md", displayPath: "notes.md", content: { type: "text", file: { filePath: "/workspace/rich/notes.md", content: "Notes file attached with an at-mention by the person." } } } }),
    line(10, 9, { type: "assistant", message: { role: "assistant", model: "claude-sonnet", content: [{ type: "text", text: "The parser now keeps tool output, thinking and images." }] } }),
    line(11, 10, { type: "system", subtype: "turn_duration", durationMs: 1200 }),
    { type: "summary", summary: "Importer fix for dropped tool output", leafUuid: uuid(0xc00a) },
    { type: "ai-title", aiTitle: "Fix the importer dropping tool output", sessionId: base.sessionId },
    { type: "file-history-snapshot", messageId: uuid(0xc00a), snapshot: { trackedFileBackups: {} } },
  ]);
}

function codex() {
  const item = (payload) => ({ timestamp: AT, type: "response_item", payload });
  return jsonl([
    { timestamp: AT, type: "session_meta", payload: { id: "rich-codex-rollout", cwd: "/workspace/rich", originator: "codex_cli_rs", cli_version: "0.50.0", base_instructions: { text: "harness instructions" } } },
    { timestamp: AT, type: "turn_context", payload: { cwd: "/workspace/rich", model: "gpt-5", approval_policy: "on-request" } },
    item({ type: "message", role: "developer", content: [{ type: "input_text", text: "Developer instructions: keep answers short and cite files." }] }),
    item({ type: "message", role: "user", content: [
      { type: "input_text", text: "Why does the rollout importer lose images?" },
      { type: "input_image", image_url: `data:image/png;base64,${PNG}` },
    ] }),
    item({ type: "reasoning", summary: [{ type: "summary_text", text: "Looking at how tool outputs are stored by the importer." }], encrypted_content: "Z0FBQUFBQm9FbmNyeXB0ZWRSZWFzb25pbmdGaXh0dXJl" }),
    item({ type: "function_call", name: "shell", call_id: "call_rich_shell", arguments: JSON.stringify({ command: ["rg", "output", "src/importer"] }) }),
    item({ type: "function_call_output", call_id: "call_rich_shell", output: "src/importer/codex.ts: const output = stringify(payload.output)" }),
    item({ type: "custom_tool_call", name: "apply_patch", call_id: "call_rich_patch", input: "*** Begin Patch\n*** Update File: src/importer/codex.ts\n-old line of the importer\n+new line of the importer\n*** End Patch" }),
    item({ type: "custom_tool_call_output", call_id: "call_rich_patch", output: [
      { type: "input_text", text: "Patch applied to the importer successfully." },
      { type: "input_image", image_url: `data:image/png;base64,${PNG}`, detail: "auto" },
    ] }),
    item({ type: "local_shell_call", call_id: "call_rich_local", status: "completed", action: { type: "exec", command: ["npm", "test", "--", "importer"] } }),
    item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "The importer stringified array outputs; it now keeps text and images.", annotations: [] }] }),
    { timestamp: AT, type: "event_msg", payload: { type: "agent_message", message: "The importer stringified array outputs; it now keeps text and images." } },
    item({ type: "additional_tools", role: "developer", tools: [{ name: "shell", description: "tool catalogue the harness offers" }] }),
    { timestamp: AT, type: "compacted", payload: { message: "Compaction summary: the importer now keeps array outputs.", replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Why does the rollout importer lose images?" }] }] } },
    item({ type: "compaction", encrypted_content: "Q29tcGFjdGlvbkVuY3J5cHRlZEhpc3RvcnlGaXh0dXJl" }),
  ]);
}

function antigravity() {
  const step = (step_index, type, extra) => ({ step_index, source: "MODEL", type, status: "DONE", created_at: AT, ...extra });
  return jsonl([
    step(0, "USER_INPUT", { source: "USER_EXPLICIT", content: "Find out why the step log importer drops errors." }),
    step(1, "CONVERSATION_HISTORY", { source: "SYSTEM" }),
    step(2, "PLANNER_RESPONSE", { thinking: "The importer only accepts four named step types.", tool_calls: [{ name: "run_command", args: { CommandLine: "grep -n GENERIC src/importer.ts", toolSummary: "search the importer" } }], input_tokens: 10, output_tokens: 4, cache_read_tokens: 0 }),
    step(3, "GENERIC", { content: "src/importer.ts:12: if (type === 'VIEW_FILE') keep the output" }),
    step(4, "PLANNER_RESPONSE", { tool_calls: [{ name: "view_file", args: { AbsolutePath: "/workspace/rich/missing.ts" } }] }),
    step(5, "GENERIC", { error: "view_file failed: the file does not exist on disk" }),
    step(6, "ERROR_MESSAGE", { source: "SYSTEM", error: "Model request failed once and was retried by the CLI." }),
    step(7, "SYSTEM_MESSAGE", { source: "SYSTEM", content: "System message injected into the conversation by the CLI." }),
    step(8, "PLANNER_RESPONSE", { content: "GENERIC steps and errors are kept now." }),
    step(9, "CHECKPOINT", { source: "SYSTEM", content: "{{ CHECKPOINT 1 }}" }),
  ]);
}

function taskHistory() {
  return `${JSON.stringify([
    { role: "user", ts: 1755680400000, content: [{ type: "text", text: "<task>Make the task importer keep tool output.</task>" }] },
    { role: "assistant", ts: 1755680401000, content: [
      { type: "reasoning", text: "The task history stores Anthropic blocks verbatim." },
      { type: "thinking", thinking: "Tool results arrive as arrays of text and images.", signature: "U2lnbmF0dXJlRm9yVGFza0hpc3RvcnlGaXh0dXJl" },
      { type: "text", text: "Reading the importer source first." },
      { type: "tool_use", id: "toolu_task_read", name: "read_file", input: { path: "src/task.ts" } },
    ] },
    { role: "user", ts: 1755680402000, content: [
      { type: "tool_result", tool_use_id: "toolu_task_read", content: [{ type: "text", text: "export const keepOutput = false; // task importer" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] },
      { type: "text", text: "<environment_details>Workspace listing for the task importer</environment_details>" },
    ] },
  ], null, 2)}\n`;
}

function chatgpt() {
  const node = (id, parent, children, author, content, extra = {}) => ({ id, parent, children, message: { id, author: { role: author }, create_time: 1755680400, content, ...extra } });
  const nodes = [
    node("r1", null, ["r2"], "system", { content_type: "user_editable_context", user_profile: "Profile text the person wrote for the assistant.", user_instructions: "Instructions: answer in short paragraphs." }),
    node("r2", "r1", ["r3"], "user", { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://file-RichFixtureImage", size_bytes: 68, width: 1, height: 1 }, "What does this chart of importer errors show?"] }),
    node("r3", "r2", ["r4"], "assistant", { content_type: "thoughts", thoughts: [{ summary: "Reading the chart", content: "The chart shows errors rising after the importer change." }] }),
    node("r4", "r3", ["r5"], "assistant", { content_type: "reasoning_recap", content: "Thought about the importer chart for a few seconds." }),
    node("r5", "r4", ["r6"], "assistant", { content_type: "code", language: "unknown", text: "import pandas\nprint(errors_by_day())" }, { recipient: "python" }),
    node("r6", "r5", ["r7"], "tool", { content_type: "execution_output", text: "day 1: 3 errors in the importer\nday 2: 9 errors in the importer" }),
    node("r7", "r6", ["r8"], "tool", { content_type: "tether_quote", url: "https://example.invalid/importer", title: "Importer release notes", text: "Release notes quote about the importer change." }),
    node("r8", "r7", ["r9"], "tool", { content_type: "system_error", name: "tool_error", text: "The browsing tool returned an error for the importer page." }),
    node("r9", "r8", [], "assistant", { content_type: "text", parts: ["The importer change tripled the daily error count."] }),
  ];
  const exported = [{ id: "rich-chatgpt-conversation", title: "Importer chart", mapping: Object.fromEntries(nodes.map((entry) => [entry.id, entry])) }];
  // A fixed mtime, so the archive is the same bytes on every run.
  return zipSync({ "conversations.json": [strToU8(`${JSON.stringify(exported, null, 2)}\n`), { mtime: new Date(AT) }] }, { level: 0 });
}

function copilotChat() {
  return `${JSON.stringify({
    version: 3,
    sessionId: "rich-copilot-panel",
    creationDate: 1755680400000,
    customTitle: "Copilot importer panel",
    requests: [{
      requestId: "request-rich-1",
      timestamp: 1755680400000,
      message: { text: "Explain why the chat importer drops tool results.", parts: [{ text: "Explain why the chat importer drops tool results." }] },
      response: [
        { kind: "thinking", value: "The importer reads only the invocation message." },
        { value: "The chat importer kept the message and dropped the tool's details.", supportThemeIcons: false },
        { kind: "toolInvocationSerialized", toolId: "run_in_terminal", toolCallId: "tool-rich-1", invocationMessage: "Running the importer tests", pastTenseMessage: "Ran the importer tests", isConfirmed: true, isComplete: true,
          toolSpecificData: { kind: "terminal", command: "npm test -- chat-importer" }, resultDetails: { output: "4 importer tests failed in the terminal" } },
        { kind: "textEditGroup", uri: { fsPath: "/workspace/rich/importer.ts" }, edits: [[{ text: "keep every response part in the chat importer" }]] },
      ],
    }],
  }, null, 2)}\n`;
}

/** Text-based rich fixtures: [source, version, input file name, bytes]. */
export function richTextInputs() {
  return [
    ["claude-code", "v1", "session.jsonl", claudeCode()],
    ["codex", "rollout-v1", "session.jsonl", codex()],
    ["antigravity-cli", "v1", "transcript.jsonl", antigravity()],
    ["roo", "v1", "task.json", taskHistory()],
    ["kilo", "v1", "task.json", taskHistory()],
    ["chatgpt-export", "2026-08", "export.zip", chatgpt()],
    ["copilot", "v1", "session.json", copilotChat()],
  ];
}
