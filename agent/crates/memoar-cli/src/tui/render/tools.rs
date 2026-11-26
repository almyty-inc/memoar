//! Tool calls drawn by what they did: an edit as a diff, a shell command
//! with its output, a file read as one line with its path and length.
//!
//! A call and its result are drawn together, so the result block that
//! follows in the transcript is skipped.

use ratatui::text::{Line, Span};
use serde_json::Value;
use std::collections::HashMap;

use super::diff::{self, Change};
use super::wrap;
use crate::tui::style;
use crate::tui::text::{first_line, truncate};

/// Lines of shell output shown under a command.
const OUTPUT_LINES: usize = 8;

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

fn header(glyph: &str, name: &str, detail: &str, columns: usize, indent: &str) -> Line<'static> {
    let lead = format!("{indent}{glyph} {name} ");
    let room = columns.saturating_sub(crate::tui::text::width(&lead));
    Line::from(vec![
        Span::styled(format!("{indent}{glyph} "), style::dim()),
        Span::styled(format!("{name} "), style::bold()),
        Span::styled(truncate(&detail.replace('\n', " "), room), style::dim()),
    ])
}

fn count(text: &str, one: &str, many: &str) -> String {
    crate::tui::model::plural(text.lines().count() as u64, one, many)
}

/// Draws one call. The result, when there is one, is drawn with it.
pub(crate) fn call(
    block: &Value,
    results: &Results,
    columns: usize,
    indent: &str,
    out: &mut Vec<Line<'static>>,
) {
    let glyphs = style::glyphs();
    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
    let data = block.get("data").unwrap_or(&Value::Null);
    let result = block
        .get("callId")
        .and_then(Value::as_str)
        .and_then(|id| results.get(id));
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
    match name.to_ascii_lowercase().as_str() {
        "edit"
        | "multiedit"
        | "edit_file"
        | "replace"
        | "str_replace_editor"
        | "str_replace_based_edit_tool" => {
            out.push(header(glyphs.collapsed, name, path, columns, indent));
            let edits = data
                .get("edits")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_else(|| vec![data.clone()]);
            for edit in &edits {
                let old = field(edit, &["old_string", "old_str", "oldString"]);
                let new = field(edit, &["new_string", "new_str", "newString"]);
                diff::draw(&diff::compare(old, new), columns, indent, out);
            }
        }
        "write" | "create_file" | "write_file" => {
            let content = field(data, &["content", "contents", "file_text"]);
            let detail = format!(
                "{path} {} {}",
                glyphs.separator,
                count(content, "line", "lines")
            );
            out.push(header(glyphs.collapsed, name, &detail, columns, indent));
            let added: Vec<(Change, &str)> =
                content.lines().map(|line| (Change::Added, line)).collect();
            diff::draw(&added, columns, indent, out);
        }
        "apply_patch" => {
            let patch = data
                .as_str()
                .unwrap_or_else(|| field(data, &["input", "patch"]));
            out.push(header(glyphs.collapsed, name, "", columns, indent));
            diff::draw(&diff::classify(patch), columns, indent, out);
        }
        "bash" | "shell" | "exec_command" | "local_shell" | "run_shell_command" | "terminal" => {
            shell(data, result, columns, indent, out);
            return;
        }
        "read" | "view" | "read_file" | "cat" => {
            let length = result
                .map(|(text, _)| count(text, "line", "lines"))
                .unwrap_or_default();
            let detail = [path, &length]
                .iter()
                .filter(|part| !part.is_empty())
                .copied()
                .collect::<Vec<_>>();
            out.push(header(
                glyphs.collapsed,
                name,
                &detail.join(&format!(" {} ", glyphs.separator)),
                columns,
                indent,
            ));
        }
        "grep" | "glob" | "search" | "find" | "ls" | "list_dir" => {
            let pattern = field(data, &["pattern", "query", "path"]);
            let found = result
                .map(|(text, _)| count(text, "result", "results"))
                .unwrap_or_default();
            out.push(header(
                glyphs.collapsed,
                name,
                &format!("{pattern}  {found}"),
                columns,
                indent,
            ));
        }
        _ => {
            out.push(header(
                glyphs.collapsed,
                name,
                &compact(data),
                columns,
                indent,
            ));
            // A failure is drawn below, as it is for every kind of tool.
            if let Some((text, false)) = result {
                out.push(result_line(text, false, columns, indent));
            }
        }
    }
    if let Some((text, true)) = result {
        out.push(result_line(text, true, columns, indent));
    }
}

/// `$ command` and the first lines of what it printed, in a gutter.
fn shell(
    data: &Value,
    result: Option<&(String, bool)>,
    columns: usize,
    indent: &str,
    out: &mut Vec<Line<'static>>,
) {
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
    let prompt = vec![Span::styled(format!("{indent}$ "), style::accent())];
    out.extend(wrap::chars(&[(command, style::code())], columns, &prompt));
    let Some((text, error)) = result else {
        return;
    };
    let gutter_style = if *error {
        style::removed()
    } else {
        style::dim()
    };
    let gutter = vec![Span::styled(
        format!("{indent}{} ", style::glyphs().gutter),
        gutter_style,
    )];
    let lines: Vec<&str> = text.trim_end().lines().collect();
    for line in lines.iter().take(OUTPUT_LINES) {
        out.extend(wrap::chars(
            &[(line.replace('\t', "    "), style::dim())],
            columns,
            &gutter,
        ));
    }
    if lines.len() > OUTPUT_LINES {
        out.push(Line::styled(
            format!(
                "{indent}{} {} more lines",
                style::glyphs().ellipsis,
                lines.len() - OUTPUT_LINES
            ),
            style::dim(),
        ));
    }
}

/// A result on one line: its first line and how many follow.
pub(crate) fn result_line(text: &str, error: bool, columns: usize, indent: &str) -> Line<'static> {
    let lines = text.trim().lines().count();
    let first = first_line(text);
    let summary = match lines {
        0 => "empty".to_owned(),
        1 => first.to_owned(),
        _ => format!("{first} ({lines} lines)"),
    };
    let label = if error { "error" } else { "result" };
    let text = format!("{indent}  {} {label}: {summary}", style::glyphs().result);
    let line_style = if error {
        style::removed()
    } else {
        style::dim()
    };
    Line::styled(truncate(&text, columns), line_style)
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
