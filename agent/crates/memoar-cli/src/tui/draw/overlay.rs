//! The command palette, the target picker and the result of a conversion,
//! drawn over whatever is behind them.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph};

use super::pane::frame_pane;
use crate::tui::app::{App, Overlay, TARGETS};
use crate::tui::palette::items;
use crate::tui::style;
use crate::tui::text::{fit, truncate, width};

pub(super) fn draw(frame: &mut Frame, app: &App, overlay: &Overlay, area: Rect) {
    match overlay {
        Overlay::Palette { input, selected } => palette(frame, app, input, *selected, area),
        Overlay::ConvertPicker {
            title, selected, ..
        } => {
            let mut lines = vec![
                Line::styled(format!(" {}", truncate(title, 50)), style::dim()),
                Line::default(),
            ];
            for (index, (id, label)) in TARGETS.iter().enumerate() {
                let text = format!(" {}  {label:<16} {id}", index + 1);
                lines.push(Line::styled(text, row_style(index == *selected)));
            }
            lines.push(Line::default());
            lines.push(Line::styled(
                " Writes it here and never over a file that differs.",
                style::dim(),
            ));
            boxed(frame, area, "Convert to", lines, 58);
        }
        Overlay::Message { title, lines } => {
            let lines: Vec<Line<'static>> = lines
                .iter()
                .map(|line| {
                    let line_style = if line.starts_with("$ ") {
                        style::code()
                    } else {
                        style::plain()
                    };
                    Line::styled(format!(" {line}"), line_style)
                })
                .collect();
            // Wide enough for the resume command, which is no use cut short.
            let longest = lines.iter().map(Line::width).max().unwrap_or(0) as u16;
            boxed(frame, area, title, lines, (longest + 3).max(64));
        }
    }
}

fn row_style(selected: bool) -> ratatui::style::Style {
    if selected {
        style::selected()
    } else {
        style::plain()
    }
}

/// A box in the middle of the screen, as tall as its lines once wrapped.
/// A line too long for the box, such as an error with a path, wraps rather
/// than losing its end.
fn boxed(frame: &mut Frame, area: Rect, title: &str, lines: Vec<Line<'static>>, wide: u16) {
    let box_width = wide.min(area.width.saturating_sub(4)).max(20);
    let room = usize::from(box_width.saturating_sub(2));
    let lines: Vec<Line<'static>> = lines
        .into_iter()
        .flat_map(|line| {
            let text: String = line
                .spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect();
            if width(&text) <= room {
                return vec![line];
            }
            crate::tui::render::wrap::chars(
                &[(text.trim_start().to_owned(), line.style)],
                room,
                &[Span::raw(" ")],
            )
        })
        .collect();
    let box_height = (lines.len() as u16 + 2).min(area.height.saturating_sub(2));
    let rect = Rect::new(
        area.x + (area.width.saturating_sub(box_width)) / 2,
        area.y + (area.height.saturating_sub(box_height)) / 3,
        box_width,
        box_height,
    );
    frame.render_widget(Clear, rect);
    let inner = frame_pane(frame, rect, title, &[], true);
    let lines = lines
        .into_iter()
        .map(|line| {
            let text: String = line
                .spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect();
            let line_style = line
                .spans
                .last()
                .map_or(line.style, |span| line.style.patch(span.style));
            Line::styled(fit(&text, usize::from(inner.width)), line_style)
        })
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(lines), inner);
}

fn palette(frame: &mut Frame, app: &App, input: &str, selected: usize, area: Rect) {
    let found = items(app, input);
    let box_width = 76.min(area.width.saturating_sub(4));
    // As tall as what matches, so a narrow query gives a small box.
    let room = usize::from(area.height.saturating_sub(8)).clamp(3, 14);
    let visible = found.len().clamp(1, room);
    let box_height = (visible as u16 + 4).min(area.height.saturating_sub(2));
    let rect = Rect::new(
        area.x + (area.width - box_width) / 2,
        area.y + 2,
        box_width,
        box_height,
    );
    frame.render_widget(Clear, rect);
    let facts = vec![crate::tui::model::plural(
        found.len() as u64,
        "match",
        "matches",
    )];
    let inner = frame_pane(frame, rect, "Commands", &facts, true);
    let columns = usize::from(inner.width);
    let mut lines = vec![
        Line::from(vec![
            Span::styled(" : ", style::accent()),
            Span::raw(input.to_owned()),
            Span::styled(style::glyphs().cursor, style::accent()),
        ]),
        Line::default(),
    ];
    let first = selected.saturating_sub(visible.saturating_sub(1));
    for (index, item) in found.iter().enumerate().skip(first).take(visible) {
        let chosen = index == selected;
        let base = row_style(chosen);
        let key = if item.key.is_empty() {
            String::new()
        } else {
            format!(" {} ", item.key)
        };
        let detail = if item.detail.is_empty() {
            String::new()
        } else {
            format!("  {}", item.detail)
        };
        let room = columns.saturating_sub(width(&key) + 2);
        let label = truncate(&item.label, room);
        let mut spans = vec![Span::styled(" ", base)];
        for (position, character) in label.chars().enumerate() {
            let matched = item.matched.contains(&position);
            let character_style = if matched && !chosen {
                style::accent().add_modifier(ratatui::style::Modifier::BOLD)
            } else {
                base
            };
            spans.push(Span::styled(character.to_string(), character_style));
        }
        let detail = truncate(&detail, room.saturating_sub(width(&label)));
        let gap = room.saturating_sub(width(&label) + width(&detail));
        spans.push(Span::styled(
            detail,
            if chosen { base } else { style::dim() },
        ));
        spans.push(Span::styled(" ".repeat(gap + 1), base));
        spans.push(Span::styled(key, if chosen { base } else { style::dim() }));
        lines.push(Line::from(spans));
    }
    frame.render_widget(Paragraph::new(lines), inner);
}
