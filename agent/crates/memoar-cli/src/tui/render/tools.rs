//! Tool calls as steps: one line each, with a status dot and the outcome on
//! the right. An edit keeps its diff under the step, and a failed command
//! keeps the first lines of what it printed.
//!
//! A call and its result are drawn together, so the result block that
//! follows in the transcript is skipped.

use ratatui::text::Line;
use serde_json::Value;
use std::collections::HashMap;

use super::diff::{self, Change};
use super::steps::{Status, output, result_line, step};
use crate::tui::model::plural;
use crate::tui::text::truncate;

/// Each result's text and whether the tool failed, by call id.
pub(crate) type Results = HashMap<String, (String, bool)>;

pub(crate) fn collect(turns: &[Value]) -> Results {
    let mut results = Results::new();
    for block in turns
        .iter()
        .filter_map(|turn| turn.get("blocks").and_then(Value::as_array))
        .flatten()
        .filter(|block| block.get("kind").and_then(Value::as_str) == Some("tool_result"))
    {
        if let Some(id) = block.get("callId").and_then(Value::as_str) {
            let text = block
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let error = block.pointer("/data/isError").and_then(Value::as_bool) == Some(true);
            results.insert(id.to_owned(), (text.to_owned(), error));
        }
    }
    results
}

fn field<'a>(data: &'a Value, names: &[&str]) -> &'a str {
    names
        .iter()
        .find_map(|name| data.get(*name).and_then(Value::as_str))
        .unwrap_or_default()
}

fn count(text: &str, one: &str, many: &str) -> String {
    plural(text.lines().count() as u64, one, many)
}

/// "+3 -1" for a set of changes.
fn tally(changes: &[(Change, &str)]) -> String {
    let added = changes
        .iter()
        .filter(|(change, _)| *change == Change::Added)
        .count();
    let removed = changes
        .iter()
        .filter(|(change, _)| *change == Change::Removed)
        .count();
    format!("+{added} -{removed}")
}

/// Draws one call. The result, when there is one, is drawn with it.
pub(crate) fn call(
    block: &Value,
    results: &Results,
    columns: usize,
    indent: &str,
    out: &mut Vec<Line<'static>>,
) {
    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
    let data = block.get("data").unwrap_or(&Value::Null);
    let result = block
        .get("callId")
        .and_then(Value::as_str)
        .and_then(|id| results.get(id));
    let status = match result {
        None => Status::Pending,
        Some((_, true)) => Status::Failed,
        Some((_, false)) => Status::Passed,
    };
    let path = field(
        data,
        &[
            "file_path",
            "path",
            "filePath",
            "notebook_path",
            "target_file",
        ],
    );
    let outcome = |text: String| {
        if status == Status::Failed {
            "failed".to_owned()
        } else {
            text
        }
    };
    match name.to_ascii_lowercase().as_str() {
        "edit"
        | "multiedit"
        | "edit_file"
        | "replace"
        | "str_replace_editor"
        | "str_replace_based_edit_tool" => {
            let edits = data
                .get("edits")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_else(|| vec![data.clone()]);
            let pairs: Vec<(&str, &str)> = edits
                .iter()
                .map(|edit| {
                    (
                        field(edit, &["old_string", "old_str", "oldString"]),
                        field(edit, &["new_string", "new_str", "newString"]),
                    )
                })
                .collect();
            let changes: Vec<Vec<(Change, &str)>> = pairs
                .iter()
                .map(|(old, new)| diff::compare(old, new))
                .collect();
            let all: Vec<(Change, &str)> = changes.iter().flatten().copied().collect();
            out.push(step(
                status,
                name,
                path,
                &outcome(tally(&all)),
                columns,
                indent,
            ));
            for change in &changes {
                diff::draw(change, columns, indent, out);
            }
        }
        "write" | "create_file" | "write_file" => {
            let content = field(data, &["content", "contents", "file_text"]);
            out.push(step(
                status,
                name,
                path,
                &outcome(count(content, "line", "lines")),
                columns,
                indent,
            ));
            let added: Vec<(Change, &str)> =
                content.lines().map(|line| (Change::Added, line)).collect();
            diff::draw(&added, columns, indent, out);
        }
        "apply_patch" => {
            let patch = data
                .as_str()
                .unwrap_or_else(|| field(data, &["input", "patch"]));
            let changes = diff::classify(patch);
            out.push(step(
                status,
                name,
                "",
                &outcome(tally(&changes)),
                columns,
                indent,
            ));
            diff::draw(&changes, columns, indent, out);
        }
        "bash" | "shell" | "exec_command" | "local_shell" | "run_shell_command" | "terminal" => {
            let command = match data.get("command").or_else(|| data.get("cmd")) {
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" "),
                Some(Value::String(command)) => command.clone(),
                _ => data
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| compact(data)),
            };
            let verdict = match status {
                Status::Pending => "",
                Status::Passed => "passed",
                Status::Failed => "failed",
            };
            out.push(step(status, "$", &command, verdict, columns, indent));
            // What a failed command printed is why it failed. A passing one
            // is a line, like every other step.
            if let Some((text, true)) = result {
                output(text, columns, indent, out);
            }
            return;
        }
        "read" | "view" | "read_file" | "cat" => {
            let length = result
                .map(|(text, _)| count(text, "line", "lines"))
                .unwrap_or_default();
            out.push(step(status, name, path, &outcome(length), columns, indent));
        }
        "grep" | "glob" | "search" | "find" | "ls" | "list_dir" => {
            let pattern = field(data, &["pattern", "query", "path"]);
            let found = result
                .map(|(text, _)| count(text, "result", "results"))
                .unwrap_or_default();
            out.push(step(
                status,
                name,
                pattern,
                &outcome(found),
                columns,
                indent,
            ));
        }
        _ => {
            let done = if result.is_some() { "done" } else { "" };
            out.push(step(
                status,
                name,
                &compact(data),
                &outcome(done.to_owned()),
                columns,
                indent,
            ));
        }
    }
    if let Some((text, true)) = result {
        out.push(result_line(text, true, columns, indent));
    }
}

/// A tool's input on one line: the value of a lone field, or compact JSON.
fn compact(data: &Value) -> String {
    if data.is_null() {
        return String::new();
    }
    if let Some(object) = data.as_object()
        && object.len() == 1
        && let Some(text) = object.values().next().and_then(Value::as_str)
    {
        return text.to_owned();
    }
    truncate(&serde_json::to_string(data).unwrap_or_default(), 400)
}
