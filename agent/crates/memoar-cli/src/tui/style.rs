//! The terminal's own colours, one accent, dim for secondary text, and the
//! glyphs the terminal can draw.
//!
//! Colours are the 16 ANSI ones, which every terminal maps to its own theme,
//! so the TUI reads the same on a light background and a dark one.

use ratatui::style::{Color, Modifier, Style};
use ratatui::symbols::border;
use std::sync::OnceLock;

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
    Style::default().fg(Color::Blue)
}

/// The selected row in the focused list.
pub(crate) fn selected() -> Style {
    Style::default()
        .bg(Color::Blue)
        .fg(Color::White)
        .add_modifier(Modifier::BOLD)
}

/// The selected row in a list that does not have the keys.
pub(crate) fn selected_unfocused() -> Style {
    Style::default().add_modifier(Modifier::REVERSED)
}

pub(crate) fn added() -> Style {
    Style::default().fg(Color::Green)
}

pub(crate) fn removed() -> Style {
    Style::default().fg(Color::Red)
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
}

pub(crate) const UNICODE: Glyphs = Glyphs {
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
