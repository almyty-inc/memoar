//! A session's turns as terminal lines, wrapped to a width.
//!
//! Prose is Markdown, code blocks are highlighted, and a tool call is drawn
//! by what it did (see `tools`). Thinking is one dim line until `t` shows it.

pub(crate) mod code;
pub(crate) mod diff;
pub(crate) mod markdown;
pub(crate) mod tools;
pub(crate) mod wrap;

use chrono::{DateTime, Local};
use ratatui::style::Modifier;
use ratatui::text::{Line, Span};
use serde_json::Value;
use std::cell::RefCell;
use std::rc::Rc;

use crate::tui::style;
use tools::Results;

const INDENT: &str = "  ";

pub(crate) type Rendered = Rc<Vec<Line<'static>>>;

/// What a rendering depends on: the width, whether thinking shows, and how
/// many turns are loaded (they are only ever appended).
type MemoKey = (u16, bool, usize);

/// The last rendering of a transcript and what it was rendered for, so a
/// frame that changes nothing does not highlight every code block again.
#[derive(Debug, Default)]
pub(crate) struct Memo {
    cell: RefCell<Option<(MemoKey, Rendered)>>,
}

impl Memo {
    pub(crate) fn get(&self, turns: &[Value], columns: u16, show_thinking: bool) -> Rendered {
        let key = (columns, show_thinking, turns.len());
        if let Some((cached, rendered)) = self.cell.borrow().as_ref()
            && *cached == key
        {
            return Rc::clone(rendered);
        }
        let rendered = Rc::new(lines(turns, columns, show_thinking));
        *self.cell.borrow_mut() = Some((key, Rc::clone(&rendered)));
        rendered
    }
}

pub(crate) fn lines(turns: &[Value], columns: u16, show_thinking: bool) -> Vec<Line<'static>> {
    let columns = usize::from(columns).max(16);
    let results = tools::collect(turns);
    let calls: std::collections::HashSet<&str> = turns
        .iter()
        .filter_map(|turn| turn.get("blocks").and_then(Value::as_array))
        .flatten()
        .filter(|block| block.get("kind").and_then(Value::as_str) == Some("tool_call"))
        .filter_map(|block| block.get("callId").and_then(Value::as_str))
        .collect();
    let mut out = Vec::new();
    for turn in turns {
        let role = turn.get("role").and_then(Value::as_str).unwrap_or("turn");
        let blocks: Vec<&Value> = turn
            .get("blocks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|block| {
                // A result already drawn under its call.
                block.get("kind").and_then(Value::as_str) != Some("tool_result")
                    || !block
                        .get("callId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| calls.contains(id))
            })
            .collect();
        if blocks.is_empty() {
            continue;
        }
        out.push(role_line(role, turn));
        for block in blocks {
            block_lines(block, &results, columns, show_thinking, &mut out);
        }
        out.push(Line::default());
    }
    out
}

fn role_line(role: &str, turn: &Value) -> Line<'static> {
    let label = match role {
        "user" => "You",
        "assistant" => "Assistant",
        "tool" => "Tool",
        "system" => "System",
        other => other,
    };
    let label_style = if role == "user" {
        style::accent().add_modifier(Modifier::BOLD)
    } else {
        style::bold()
    };
    let mut spans = vec![Span::styled(label.to_owned(), label_style)];
    if let Some(at) = turn
        .get("createdAt")
        .and_then(Value::as_str)
        .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
    {
        spans.push(Span::styled(
            format!("  {}", at.with_timezone(&Local).format("%H:%M")),
            style::dim(),
        ));
    }
    if let Some(model) = turn.get("model").and_then(Value::as_str) {
        spans.push(Span::styled(format!("  {model}"), style::dim()));
    }
    Line::from(spans)
}

fn block_lines(
    block: &Value,
    results: &Results,
    columns: usize,
    show_thinking: bool,
    out: &mut Vec<Line<'static>>,
) {
    let field = |name: &str| block.get(name).and_then(Value::as_str).unwrap_or_default();
    let text = field("text");
    let glyphs = style::glyphs();
    let note =
        |text: String| Line::styled(crate::tui::text::truncate(&text, columns), style::dim());
    match field("kind") {
        "text" => out.extend(markdown::lines(text, columns, INDENT, style::plain())),
        "thinking" if !show_thinking => out.push(note(format!(
            "{INDENT}{} thinking, t shows it",
            glyphs.collapsed
        ))),
        "thinking" if text.trim().is_empty() => {
            out.push(note(format!("{INDENT}thinking, redacted by the agent")))
        }
        "thinking" => {
            let thinking = style::dim().add_modifier(Modifier::ITALIC);
            let gutter = format!("{INDENT}{} ", glyphs.gutter);
            out.extend(markdown::lines(text, columns, &gutter, thinking));
        }
        "tool_call" => tools::call(block, results, columns, INDENT, out),
        "tool_result" => {
            let error = block.pointer("/data/isError").and_then(Value::as_bool) == Some(true);
            out.push(tools::result_line(text, error, columns, INDENT));
        }
        "diff" => diff::draw(&diff::classify(text), columns, INDENT, out),
        "artifact" | "attachment" => {
            let name = [field("name"), field("artifactRef"), field("mimeType")]
                .into_iter()
                .find(|name| !name.is_empty())
                .unwrap_or("file");
            out.push(note(format!(
                "{INDENT}{} attachment {name}",
                glyphs.collapsed
            )));
        }
        "error" => out.push(Line::styled(
            crate::tui::text::truncate(&format!("{INDENT}Error: {}", text.trim()), columns),
            style::removed(),
        )),
        "system" => {
            let label = if text.trim().is_empty() {
                field("name")
            } else {
                text
            };
            out.push(note(format!("{INDENT}{}", label.replace('\n', " "))));
        }
        other => out.push(note(format!("{INDENT}{} {other}", glyphs.collapsed))),
    }
}
