//! File edits as diffs with a `+`/`-` gutter.

use ratatui::style::Style;
use ratatui::text::{Line, Span};

use super::wrap;
use crate::tui::style;

/// Lines of one edit shown before the rest is summarised.
pub(crate) const MAX_DIFF_LINES: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Change {
    Same,
    Added,
    Removed,
}

/// A line diff of two texts. Longest common subsequence, which is exact and
/// cheap for the size of one edit. Past that size it falls back to all old
/// lines removed and all new ones added, which is still correct.
pub(crate) fn compare<'a>(old: &'a str, new: &'a str) -> Vec<(Change, &'a str)> {
    let old: Vec<&str> = old.lines().collect();
    let new: Vec<&str> = new.lines().collect();
    if old.len() * new.len() > 250_000 {
        return old
            .iter()
            .map(|line| (Change::Removed, *line))
            .chain(new.iter().map(|line| (Change::Added, *line)))
            .collect();
    }
    let mut table = vec![vec![0_u32; new.len() + 1]; old.len() + 1];
    for i in (0..old.len()).rev() {
        for j in (0..new.len()).rev() {
            table[i][j] = if old[i] == new[j] {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut out = Vec::with_capacity(old.len() + new.len());
    while i < old.len() || j < new.len() {
        if i < old.len() && j < new.len() && old[i] == new[j] {
            out.push((Change::Same, old[i]));
            i += 1;
            j += 1;
        } else if i < old.len() && (j == new.len() || table[i + 1][j] >= table[i][j + 1]) {
            out.push((Change::Removed, old[i]));
            i += 1;
        } else {
            out.push((Change::Added, new[j]));
            j += 1;
        }
    }
    out
}

/// A unified diff's own lines, classified by their first character.
pub(crate) fn classify(patch: &str) -> Vec<(Change, &str)> {
    patch
        .lines()
        .map(|line| {
            if line.starts_with("+++") || line.starts_with("---") {
                (Change::Same, line)
            } else if let Some(rest) = line.strip_prefix('+') {
                (Change::Added, rest)
            } else if let Some(rest) = line.strip_prefix('-') {
                (Change::Removed, rest)
            } else {
                (Change::Same, line.strip_prefix(' ').unwrap_or(line))
            }
        })
        .collect()
}

/// Draws changes under a gutter, at most `MAX_DIFF_LINES` of them.
pub(crate) fn draw(
    changes: &[(Change, &str)],
    columns: usize,
    indent: &str,
    out: &mut Vec<Line<'static>>,
) {
    for (change, text) in changes.iter().take(MAX_DIFF_LINES) {
        let (mark, line_style) = match change {
            Change::Added => ("+", style::added()),
            Change::Removed => ("-", style::removed()),
            Change::Same => (" ", style::dim()),
        };
        let gutter = vec![
            Span::raw(indent.to_owned()),
            Span::styled(format!("{mark} "), line_style),
        ];
        let pieces: Vec<(String, Style)> = vec![(text.replace('\t', "    "), line_style)];
        for mut line in wrap::chars(&pieces, columns, &gutter) {
            // The tint runs to the edge, so a change reads as a band.
            let used = line.width();
            line.spans.push(Span::styled(
                " ".repeat(columns.saturating_sub(used)),
                line_style,
            ));
            out.push(line);
        }
    }
    if changes.len() > MAX_DIFF_LINES {
        out.push(Line::styled(
            format!(
                "{indent}{} {} more lines",
                style::glyphs().ellipsis,
                changes.len() - MAX_DIFF_LINES
            ),
            style::dim(),
        ));
    }
}
