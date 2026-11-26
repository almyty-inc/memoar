//! Wrapping styled text to a width, keeping each word's style.

use ratatui::style::Style;
use ratatui::text::{Line, Span};
use unicode_width::UnicodeWidthChar;

use crate::tui::text::width;

/// Word-wraps `spans`, starting every line with `prefix` (an indent or a
/// gutter). A word longer than a line is broken where it reaches the edge.
pub(crate) fn words(
    spans: &[(String, Style)],
    columns: usize,
    prefix: &[Span<'static>],
) -> Vec<Line<'static>> {
    let room = columns
        .saturating_sub(prefix.iter().map(|span| width(&span.content)).sum())
        .max(4);
    let mut lines = Vec::new();
    let mut line: Vec<Span<'static>> = Vec::new();
    let mut used = 0;
    let mut pending_space: Option<Style> = None;
    let finish = |line: &mut Vec<Span<'static>>, lines: &mut Vec<Line<'static>>| {
        let mut full = prefix.to_vec();
        full.append(line);
        lines.push(Line::from(full));
    };
    for (text, style) in spans {
        for (index, word) in text.split(' ').enumerate() {
            if index > 0 {
                pending_space = Some(*style);
            }
            if word.is_empty() {
                continue;
            }
            let size = width(word);
            let space = usize::from(pending_space.is_some() && used > 0);
            if used > 0 && used + space + size > room {
                finish(&mut line, &mut lines);
                used = 0;
            } else if let Some(space_style) = pending_space.filter(|_| used > 0) {
                line.push(Span::styled(" ", space_style));
                used += 1;
            }
            pending_space = None;
            if size <= room {
                line.push(Span::styled(word.to_owned(), *style));
                used += size;
                continue;
            }
            for piece in pieces(word, room - used.min(room), room) {
                if used > 0 && used + width(&piece) > room {
                    finish(&mut line, &mut lines);
                    used = 0;
                }
                used += width(&piece);
                line.push(Span::styled(piece, *style));
            }
        }
    }
    if !line.is_empty() || lines.is_empty() {
        finish(&mut line, &mut lines);
    }
    lines
}

/// Breaks styled text at the edge, character by character, as code is
/// wrapped: spaces are kept and nothing is reflowed.
pub(crate) fn chars(
    spans: &[(String, Style)],
    columns: usize,
    prefix: &[Span<'static>],
) -> Vec<Line<'static>> {
    let room = columns
        .saturating_sub(prefix.iter().map(|span| width(&span.content)).sum())
        .max(4);
    let mut lines = Vec::new();
    let mut line: Vec<Span<'static>> = prefix.to_vec();
    let mut used = 0;
    for (text, style) in spans {
        let mut piece = String::new();
        for character in text.chars() {
            let size = character.width().unwrap_or(0);
            if used + size > room {
                if !piece.is_empty() {
                    line.push(Span::styled(std::mem::take(&mut piece), *style));
                }
                lines.push(Line::from(std::mem::replace(&mut line, prefix.to_vec())));
                used = 0;
            }
            piece.push(character);
            used += size;
        }
        if !piece.is_empty() {
            line.push(Span::styled(piece, *style));
        }
    }
    lines.push(Line::from(line));
    lines
}

/// A long word cut into pieces: the first fits what is left of the line,
/// the rest fit a whole line each.
fn pieces(word: &str, first: usize, room: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut piece = String::new();
    let mut used = 0;
    let mut limit = first.max(1);
    for character in word.chars() {
        let size = character.width().unwrap_or(0);
        if used + size > limit && !piece.is_empty() {
            out.push(std::mem::take(&mut piece));
            used = 0;
            limit = room;
        }
        piece.push(character);
        used += size;
    }
    if !piece.is_empty() {
        out.push(piece);
    }
    out
}
