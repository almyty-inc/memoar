//! Syntax highlighting for code blocks, in the terminal's own colours.
//!
//! syntect supplies the grammars and the parse. The colours are not a bundled
//! theme but a short map from scope to one of the 16 ANSI colours, which each
//! terminal draws in its own palette, light or dark.

use ratatui::style::{Color, Modifier, Style};
use std::sync::OnceLock;
use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};

use crate::tui::style;

/// Longer code blocks are shown plain: highlighting them is slow and the
/// colours add little to a page of output.
const MAX_HIGHLIGHTED_LINES: usize = 400;

fn syntaxes() -> &'static SyntaxSet {
    static SET: OnceLock<SyntaxSet> = OnceLock::new();
    SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

/// Loads the grammars, so the first code block does not wait for them.
pub(crate) fn warm() {
    let _ = syntaxes();
}

/// The grammar for a fence's language or a file's extension.
fn find<'a>(set: &'a SyntaxSet, language: &str) -> Option<&'a SyntaxReference> {
    let language = language.trim().to_ascii_lowercase();
    if language.is_empty() {
        return None;
    }
    let token = match language.as_str() {
        "ts" | "tsx" | "typescript" | "jsx" | "mjs" | "cjs" => "js",
        "shell" | "zsh" | "console" | "sh" => "bash",
        "yml" => "yaml",
        "rs" => "rust",
        "py" => "python",
        other => other,
    };
    set.find_syntax_by_token(token)
        .or_else(|| set.find_syntax_by_extension(token))
}

/// Each line as styled pieces. Unknown languages come back in one colour.
pub(crate) fn highlight(code: &[&str], language: &str) -> Vec<Vec<(String, Style)>> {
    let set = syntaxes();
    let plain = |line: &&str| vec![((*line).to_owned(), style::code())];
    let Some(syntax) = find(set, language).filter(|_| code.len() <= MAX_HIGHLIGHTED_LINES) else {
        return code.iter().map(plain).collect();
    };
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut out = Vec::with_capacity(code.len());
    for line in code {
        let with_newline = format!("{line}\n");
        let Ok(operations) = state.parse_line(&with_newline, set) else {
            out.push(plain(line));
            continue;
        };
        let mut pieces = Vec::new();
        let mut start = 0;
        for (position, operation) in operations {
            let position = position.min(line.len());
            if position > start {
                pieces.push((line[start..position].to_owned(), colour(stack.as_slice())));
                start = position;
            }
            let _ = stack.apply(&operation);
        }
        if start < line.len() {
            pieces.push((line[start..].to_owned(), colour(stack.as_slice())));
        }
        out.push(pieces);
    }
    out
}

/// The colour of the innermost scope that has one.
fn colour(scopes: &[Scope]) -> Style {
    for scope in scopes.iter().rev() {
        let name = scope.build_string();
        let starts = |prefix: &str| name.starts_with(prefix);
        let style = if starts("comment") {
            Some(Style::default().add_modifier(Modifier::DIM | Modifier::ITALIC))
        } else if starts("string") {
            Some(Style::default().fg(Color::Green))
        } else if starts("constant.numeric") || starts("constant.language") {
            Some(Style::default().fg(Color::Yellow))
        } else if starts("keyword") || starts("storage") {
            Some(Style::default().fg(Color::Magenta))
        } else if starts("entity.name.function") || starts("support.function") {
            Some(Style::default().fg(Color::Blue))
        } else if starts("entity.name") || starts("support.type") || starts("support.class") {
            Some(Style::default().fg(Color::Cyan))
        } else if starts("variable.parameter") || starts("markup.heading") {
            Some(Style::default().add_modifier(Modifier::BOLD))
        } else {
            None
        };
        if let Some(style) = style {
            return style;
        }
    }
    Style::default()
}
