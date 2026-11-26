//! The Markdown agents write, drawn for a terminal: headings, lists, quotes,
//! inline code and emphasis, and fenced code blocks with highlighting.
//!
//! Line by line rather than a full CommonMark parse. Agent prose is short
//! paragraphs, lists and fences, and a line break the agent wrote is kept.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::code::highlight;
use super::wrap;
use crate::tui::style;

pub(crate) fn lines(text: &str, columns: usize, indent: &str, base: Style) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    let mut source = text.trim_matches('\n').lines();
    let glyphs = style::glyphs();
    while let Some(line) = source.next() {
        let trimmed = line.trim_start();
        if let Some(language) = trimmed.strip_prefix("```") {
            let mut code = Vec::new();
            for next in source.by_ref() {
                if next.trim_start().starts_with("```") {
                    break;
                }
                code.push(next);
            }
            code_block(&code, language, columns, indent, &mut out);
            continue;
        }
        let prefix = vec![Span::raw(indent.to_owned())];
        if trimmed.is_empty() {
            out.push(Line::default());
        } else if let Some((level, heading)) = heading(trimmed) {
            let heading_style = base.add_modifier(Modifier::BOLD);
            let heading_style = if level == 1 {
                heading_style.add_modifier(Modifier::UNDERLINED)
            } else {
                heading_style
            };
            out.extend(wrap::words(
                &inline(heading, heading_style),
                columns,
                &prefix,
            ));
        } else if let Some((symbol, item)) = bullet(trimmed) {
            let nesting = (line.len() - trimmed.len()).min(8);
            let marker = format!("{indent}{}{symbol} ", " ".repeat(nesting));
            let hanging = " ".repeat(crate::tui::text::width(&marker));
            let wrapped = wrap::words(&inline(item, base), columns, &[Span::raw(hanging)]);
            for (index, mut wrapped_line) in wrapped.into_iter().enumerate() {
                if index == 0 {
                    wrapped_line.spans[0] = Span::styled(marker.clone(), style::dim());
                }
                out.push(wrapped_line);
            }
        } else if let Some(quoted) = trimmed.strip_prefix('>') {
            let gutter = vec![Span::styled(
                format!("{indent}{} ", glyphs.gutter),
                style::dim(),
            )];
            out.extend(wrap::words(
                &inline(quoted.trim_start(), style::dim()),
                columns,
                &gutter,
            ));
        } else {
            out.extend(wrap::words(&inline(trimmed, base), columns, &prefix));
        }
    }
    out
}

/// A fenced block: a dim gutter, highlighted lines, wrapped at the edge.
pub(crate) fn code_block(
    code: &[&str],
    language: &str,
    columns: usize,
    indent: &str,
    out: &mut Vec<Line<'static>>,
) {
    let gutter = vec![Span::styled(
        format!("{indent}{} ", style::glyphs().gutter),
        style::dim(),
    )];
    for pieces in highlight(code, language.trim()) {
        out.extend(wrap::chars(&pieces, columns, &gutter));
    }
}

fn heading(line: &str) -> Option<(usize, &str)> {
    let level = line
        .chars()
        .take_while(|character| *character == '#')
        .count();
    let rest = line.get(level..)?;
    (1..=6)
        .contains(&level)
        .then_some(())
        .and(rest.strip_prefix(' '))
        .map(|text| (level, text.trim()))
}

/// A list item's marker as drawn, and its text.
fn bullet(line: &str) -> Option<(String, &str)> {
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = line.strip_prefix(marker) {
            return Some((style::glyphs().bullet.to_owned(), rest));
        }
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && digits < 4 {
        let rest = &line[digits..];
        if let Some(item) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) {
            return Some((format!("{}.", &line[..digits]), item));
        }
    }
    None
}

/// `code`, **bold** and *emphasis* as styles. Unclosed markers stay as typed.
pub(crate) fn inline(text: &str, base: Style) -> Vec<(String, Style)> {
    let mut out: Vec<(String, Style)> = Vec::new();
    let mut rest = text;
    let mut plain = String::new();
    while !rest.is_empty() {
        let found = [
            ("`", style::code()),
            ("**", base.add_modifier(Modifier::BOLD)),
            ("*", base.add_modifier(Modifier::ITALIC)),
        ]
        .into_iter()
        .find_map(|(marker, marked)| {
            let inner = rest.strip_prefix(marker)?;
            let end = inner.find(marker).filter(|end| *end > 0)?;
            Some((marker.len(), end, marked))
        });
        if let Some((marker, end, marked)) = found {
            if !plain.is_empty() {
                out.push((std::mem::take(&mut plain), base));
            }
            out.push((rest[marker..marker + end].to_owned(), marked));
            rest = &rest[marker * 2 + end..];
            continue;
        }
        let mut characters = rest.chars();
        if let Some(character) = characters.next() {
            plain.push(character);
        }
        rest = characters.as_str();
    }
    if !plain.is_empty() {
        out.push((plain, base));
    }
    out
}
