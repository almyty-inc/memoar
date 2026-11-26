//! A list of sessions, two lines a row: the title and time, then source,
//! project, machine and turns in dim.
//!
//! The session list groups rows under the day they were last updated, and
//! keeps the day of the top row pinned above the list as it scrolls.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

use crate::tui::app::{App, SessionList};
use crate::tui::model::{ListLine, SessionRow, plural};
use crate::tui::style;
use crate::tui::text::{fit, truncate, width};

/// Lines a list line takes on screen.
fn height(line: &ListLine) -> usize {
    match line {
        ListLine::Day(_) => 1,
        ListLine::Session(_) => 2,
    }
}

/// Which lines are on screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Window {
    /// The line the window scrolls from, kept between frames.
    pub(crate) offset: usize,
    /// The first line drawn under the pinned day, which skips a day heading
    /// the pin already shows.
    pub(crate) start: usize,
    /// Screen lines available under the pin.
    pub(crate) rows: usize,
}

/// Moves `offset` just far enough that the selected line is drawn whole.
pub(crate) fn window(
    lines: &[ListLine],
    selected: usize,
    offset: usize,
    rows: usize,
    pinned: bool,
) -> Window {
    let rows = rows.saturating_sub(usize::from(pinned)).max(2);
    let is_day = |index: usize| matches!(lines.get(index), Some(ListLine::Day(_)));
    let mut offset = offset.min(selected);
    loop {
        let start = offset + usize::from(pinned && is_day(offset) && offset < selected);
        let used: usize = lines
            [start.min(lines.len())..=selected.min(lines.len().saturating_sub(1))]
            .iter()
            .map(height)
            .sum();
        if used <= rows || offset >= selected {
            return Window {
                offset,
                start,
                rows,
            };
        }
        offset += 1;
    }
}

/// The day heading the line at `index` sits under.
fn day_of(lines: &[ListLine], index: usize) -> &str {
    lines[..=index.min(lines.len().saturating_sub(1))]
        .iter()
        .rev()
        .find_map(|line| match line {
            ListLine::Day(label) => Some(label.as_str()),
            ListLine::Session(_) => None,
        })
        .unwrap_or_default()
}

fn layout(list: &SessionList, lines: &[ListLine], area: Rect) -> (Window, bool) {
    let pinned = lines.iter().any(|line| matches!(line, ListLine::Day(_)));
    let selected = lines
        .iter()
        .position(|line| *line == ListLine::Session(list.selected))
        .unwrap_or(0);
    let window = window(
        lines,
        selected,
        list.offset.get(),
        usize::from(area.height),
        pinned,
    );
    (window, pinned)
}

/// The row under screen line `y`, for a click.
pub(crate) fn hit(list: &SessionList, lines: &[ListLine], area: Rect, y: u16) -> Option<usize> {
    if lines.is_empty() || y < area.y || y >= area.y + area.height {
        return None;
    }
    let (window, pinned) = layout(list, lines, area);
    let mut line_y = area.y + u16::from(pinned);
    for line in lines.iter().skip(window.start) {
        let next = line_y + height(line) as u16;
        if y >= line_y && y < next {
            return match line {
                ListLine::Session(index) => Some(*index),
                ListLine::Day(_) => None,
            };
        }
        line_y = next;
        if line_y >= area.y + area.height {
            break;
        }
    }
    None
}

pub(super) fn draw(
    frame: &mut Frame,
    app: &App,
    list: &SessionList,
    lines: &[ListLine],
    area: Rect,
    focused: bool,
) {
    if lines.is_empty() || area.height == 0 {
        return;
    }
    let (window, pinned) = layout(list, lines, area);
    list.offset.set(window.offset);
    let columns = usize::from(area.width);
    let mut out = Vec::with_capacity(usize::from(area.height));
    if pinned {
        out.push(day_line(day_of(lines, window.start), columns));
    }
    let mut used = 0;
    for line in lines.iter().skip(window.start) {
        if used + height(line) > window.rows {
            break;
        }
        used += height(line);
        match line {
            ListLine::Day(label) => out.push(day_line(label, columns)),
            ListLine::Session(index) => {
                let selected = *index == list.selected;
                let highlight = match (selected, focused) {
                    (true, true) => Some(style::selected()),
                    (true, false) => Some(style::selected_unfocused()),
                    _ => None,
                };
                out.extend(row_lines(&list.rows[*index], app, columns, highlight));
            }
        }
    }
    frame.render_widget(Paragraph::new(out), area);
}

fn day_line(label: &str, columns: usize) -> Line<'static> {
    Line::styled(
        fit(&format!(" {label}"), columns),
        style::dim().add_modifier(ratatui::style::Modifier::BOLD),
    )
}

/// A session's two lines: title and time, then the facts about it.
pub(crate) fn row_lines(
    row: &SessionRow,
    app: &App,
    columns: usize,
    highlight: Option<Style>,
) -> [Line<'static>; 2] {
    let primary = highlight.unwrap_or_else(style::plain);
    let secondary = highlight.unwrap_or_else(style::dim);
    let time = row.time();
    let room = columns.saturating_sub(width(&time) + 3);
    let mut title = row.title.replace('\n', " ");
    if let Some(highlight) = &row.highlight
        && highlight != &row.title
    {
        title = format!("{title}  {}", highlight.replace('\n', " "));
    }
    let first = Line::from(vec![
        Span::styled(" ", primary),
        Span::styled(fit(&title, room), primary),
        Span::styled(format!(" {time} "), secondary),
    ]);
    let separator = format!(" {} ", style::glyphs().separator);
    let facts: Vec<String> = [
        row.source_label.clone(),
        row.project().to_owned(),
        row.machine(&app.machines).to_owned(),
        plural(row.turn_count, "turn", "turns"),
    ]
    .into_iter()
    .filter(|fact| !fact.is_empty())
    .collect();
    let second = Line::styled(
        fit(
            &format!(
                " {}",
                truncate(&facts.join(&separator), columns.saturating_sub(2))
            ),
            columns,
        ),
        secondary,
    );
    [first, second]
}
