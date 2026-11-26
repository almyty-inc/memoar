//! The one-line step a tool call becomes, and the few lines under a step
//! that failed.

use ratatui::style::Style;
use ratatui::text::{Line, Span};

use super::wrap;
use crate::tui::style;
use crate::tui::text::{first_line, truncate, width};

/// Lines of a failed command's output shown under its step.
const OUTPUT_LINES: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Status {
    /// No result in the transcript yet.
    Pending,
    Passed,
    Failed,
}

fn status_style(status: Status) -> Style {
    match status {
        Status::Pending => style::dim(),
        Status::Passed => style::passed(),
        Status::Failed => style::failed(),
    }
}

/// `● Name  detail ....... outcome`: the dot in the status colour, the name
/// in bold, what it worked on in dim, and the outcome on the right.
pub(crate) fn step(
    status: Status,
    name: &str,
    detail: &str,
    outcome: &str,
    columns: usize,
    indent: &str,
) -> Line<'static> {
    let dot = format!("{indent}{} ", style::glyphs().dot);
    let name = format!("{name} ");
    let outcome = if outcome.is_empty() {
        String::new()
    } else {
        format!(" {outcome}")
    };
    let room = columns.saturating_sub(width(&dot) + width(&name) + width(&outcome));
    let detail = truncate(&detail.replace(['\n', '\t'], " "), room);
    let gap = room.saturating_sub(width(&detail));
    let outcome_style = match status {
        Status::Failed => style::failed(),
        Status::Passed if outcome.trim() == "passed" => style::passed(),
        _ => style::dim(),
    };
    Line::from(vec![
        Span::styled(dot, status_style(status)),
        Span::styled(name, style::bold()),
        Span::styled(detail, style::dim()),
        Span::raw(" ".repeat(gap)),
        Span::styled(outcome, outcome_style),
    ])
}

/// The first lines a failed command printed, in a gutter.
pub(crate) fn output(text: &str, columns: usize, indent: &str, out: &mut Vec<Line<'static>>) {
    let gutter = vec![Span::styled(
        format!("{indent}  {} ", style::glyphs().gutter),
        style::failed(),
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
                "{indent}    {} {} more lines",
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
    let line_style = if error { style::failed() } else { style::dim() };
    Line::styled(truncate(&text, columns), line_style)
}
