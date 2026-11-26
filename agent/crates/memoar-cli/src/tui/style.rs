//! Text styles and the glyphs the terminal can draw.
//!
//! Text is the terminal's own foreground, with dim for secondary text. The
//! almyty blue marks focus and selection, agents have their colours, and
//! success and danger have theirs (see `colour`).

use ratatui::style::{Color, Modifier, Style};
use ratatui::symbols::border;
use std::sync::OnceLock;

use super::colour::{self, Depth};

pub(crate) fn plain() -> Style {
    Style::default()
}

pub(crate) fn dim() -> Style {
    Style::default().add_modifier(Modifier::DIM)
}

pub(crate) fn bold() -> Style {
    Style::default().add_modifier(Modifier::BOLD)
}

pub(crate) fn accent() -> Style {
    Style::default().fg(colour::accent())
}

/// The selected row in the focused list: the selection surface and text,
/// or white on blue with 16 colours.
pub(crate) fn selected() -> Style {
    let style = Style::default().add_modifier(Modifier::BOLD);
    if colour::theme().depth == Depth::Ansi16 {
        return style.bg(Color::Blue).fg(Color::White);
    }
    style
        .bg(colour::selection_surface())
        .fg(colour::selection_text())
}

/// The selected row in a list that does not have the keys.
pub(crate) fn selected_unfocused() -> Style {
    if colour::theme().depth == Depth::Ansi16 {
        return Style::default().add_modifier(Modifier::REVERSED);
    }
    Style::default().bg(colour::inset())
}

fn tone((text, surface): (Color, Option<Color>)) -> Style {
    let style = Style::default().fg(text);
    match surface {
        Some(surface) => style.bg(surface),
        None => style,
    }
}

/// An added line, or a step that worked.
pub(crate) fn added() -> Style {
    tone(colour::success())
}

/// A removed line, or a step that failed.
pub(crate) fn removed() -> Style {
    tone(colour::danger())
}

/// Success or danger text without a surface, for a status dot or a word.
pub(crate) fn passed() -> Style {
    Style::default().fg(colour::success().0)
}

pub(crate) fn failed() -> Style {
    Style::default().fg(colour::danger().0)
}

/// An agent's colour, for its mark.
pub(crate) fn agent(source: &str) -> Style {
    Style::default().fg(colour::agent(source))
}

pub(crate) fn code() -> Style {
    Style::default().fg(Color::Cyan)
}

/// Characters with an ASCII stand-in, for consoles whose font has no box
/// drawing or arrows. The Windows console host is the one that matters.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Glyphs {
    pub(crate) border: border::Set<'static>,
    pub(crate) collapsed: &'static str,
    pub(crate) result: &'static str,
    pub(crate) ellipsis: &'static str,
    pub(crate) cursor: &'static str,
    pub(crate) separator: &'static str,
    pub(crate) gutter: &'static str,
    pub(crate) bullet: &'static str,
    pub(crate) thumb: &'static str,
    /// The thread beside the name, after the logo's line through its nodes.
    pub(crate) thread: &'static str,
    /// An agent's mark and a step's status.
    pub(crate) dot: &'static str,
    /// The bar beside a person's turn.
    pub(crate) bar: &'static str,
}

pub(crate) const UNICODE: Glyphs = Glyphs {
    thread: "∿",
    dot: "●",
    bar: "▌",
    border: border::ROUNDED,
    collapsed: "▸",
    result: "↳",
    ellipsis: "…",
    cursor: "█",
    separator: "·",
    gutter: "│",
    bullet: "•",
    thumb: "┃",
};

pub(crate) const ASCII: Glyphs = Glyphs {
    thread: "~",
    dot: "*",
    bar: "|",
    border: border::Set {
        top_left: "+",
        top_right: "+",
        bottom_left: "+",
        bottom_right: "+",
        vertical_left: "|",
        vertical_right: "|",
        horizontal_top: "-",
        horizontal_bottom: "-",
    },
    collapsed: ">",
    result: "<-",
    ellipsis: "...",
    cursor: "_",
    separator: "-",
    gutter: "|",
    bullet: "*",
    thumb: "#",
};

static GLYPHS: OnceLock<Glyphs> = OnceLock::new();

/// Decides once, at start. `MEMOAR_TUI_ASCII=1` forces ASCII and `=0`
/// forces Unicode. Otherwise ASCII only in a Windows console that is not
/// Windows Terminal, VS Code, or another terminal that sets `TERM`.
pub(crate) fn choose_glyphs() {
    let ascii = match std::env::var("MEMOAR_TUI_ASCII").ok().as_deref() {
        Some("1" | "true") => true,
        Some("0" | "false") => false,
        _ => {
            cfg!(windows)
                && ["WT_SESSION", "TERM_PROGRAM", "TERM"]
                    .iter()
                    .all(|name| std::env::var_os(name).is_none())
        }
    };
    let _ = GLYPHS.set(if ascii { ASCII } else { UNICODE });
}

/// Unicode unless `choose_glyphs` picked ASCII, so tests see one fixed set.
pub(crate) fn glyphs() -> &'static Glyphs {
    GLYPHS.get().unwrap_or(&UNICODE)
}
