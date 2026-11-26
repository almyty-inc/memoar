//! Choosing colours for the terminal at hand.

use ratatui::style::Color;

use crate::tui::colour::{DEFAULT, Depth, Theme, accent, agent, detect, nearest_256};

#[test]
fn the_depth_follows_what_the_terminal_says() {
    assert_eq!(
        detect("truecolor", "xterm-256color", false, "").depth,
        Depth::True
    );
    assert_eq!(detect("24bit", "", false, "").depth, Depth::True);
    assert_eq!(
        detect("", "", true, "").depth,
        Depth::True,
        "Windows Terminal"
    );
    assert_eq!(
        detect("", "xterm-256color", false, "").depth,
        Depth::Ansi256
    );
    assert_eq!(detect("", "xterm", false, "").depth, Depth::Ansi16);
    assert_eq!(
        detect("", "", false, "").depth,
        Depth::Ansi16,
        "the Windows console host"
    );
}

#[test]
fn the_background_follows_colorfgbg_and_is_dark_when_unknown() {
    assert!(detect("", "", false, "").dark);
    assert!(detect("", "", false, "15;0").dark);
    assert!(!detect("", "", false, "0;15").dark);
    assert!(!detect("", "", false, "0;default;7").dark);
}

#[test]
fn the_nearest_256_colour_is_in_the_cube_or_the_grey_ramp() {
    assert_eq!(nearest_256(255, 0, 0), 196);
    assert_eq!(nearest_256(0, 0, 0), 16);
    assert_eq!(nearest_256(128, 128, 128), 244);
    // almyty blue on dark, #7AB5FF.
    assert_eq!(nearest_256(0x7A, 0xB5, 0xFF), 111);
}

#[test]
fn tests_draw_in_truecolor_on_dark_with_the_brand_blue() {
    assert_eq!(
        DEFAULT,
        Theme {
            depth: Depth::True,
            dark: true
        }
    );
    assert_eq!(accent(), Color::Rgb(0x7A, 0xB5, 0xFF));
}

#[test]
fn agents_have_their_own_colours() {
    assert_eq!(agent("claude-code"), Color::Rgb(0xE0, 0x86, 0x5F));
    assert_eq!(
        agent("codex"),
        Color::Rgb(0x9A, 0xA3, 0xB5),
        "the dark value"
    );
    assert_eq!(agent("antigravity-cli"), Color::Rgb(0x5B, 0x8D, 0xEF));
    assert_eq!(agent("zed"), agent("zed"), "the same every time");
    assert_ne!(agent("claude-code"), agent("opencode"));
}
