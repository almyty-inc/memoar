//! The small parts: fitting text, wrapping, diffs, Markdown, highlighting,
//! grouping by day, and the list window.

use chrono::NaiveDate;
use ratatui::style::{Color, Style};
use ratatui::text::Line;

use super::fixtures::page;
use crate::tui::draw::list::window;
use crate::tui::model::{ListLine, day_label, grouped, plural, rows};
use crate::tui::render::code::highlight;
use crate::tui::render::diff::{Change, classify, compare};
use crate::tui::render::{markdown, wrap};
use crate::tui::text::{fit, truncate, width};

fn text(line: &Line) -> String {
    line.spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect()
}

#[test]
fn text_is_cut_and_padded_by_display_width() {
    assert_eq!(truncate("hello world", 8), "hello w…");
    assert_eq!(truncate("short", 8), "short");
    assert_eq!(width(&fit("日本語テキスト", 7)), 7);
    assert_eq!(fit("ab", 4), "ab  ");
}

#[test]
fn words_wrap_and_keep_their_style() {
    let bold = Style::default().fg(Color::Red);
    let lines = wrap::words(
        &[
            ("one two ".to_owned(), Style::default()),
            ("three".to_owned(), bold),
        ],
        10,
        &[ratatui::text::Span::raw("  ")],
    );
    let texts: Vec<String> = lines.iter().map(text).collect();
    assert_eq!(texts, vec!["  one two", "  three"]);
    assert_eq!(lines[1].spans.last().unwrap().style, bold);
    let long = wrap::words(&[("abcdefghijkl".to_owned(), Style::default())], 6, &[]);
    assert!(long.iter().all(|line| width(&text(line)) <= 6));
}

#[test]
fn an_edit_is_a_line_diff() {
    let changes = compare("a\nb\nc", "a\nB\nc");
    assert_eq!(
        changes,
        vec![
            (Change::Same, "a"),
            (Change::Removed, "b"),
            (Change::Added, "B"),
            (Change::Same, "c")
        ]
    );
    let patch = classify("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new");
    assert_eq!(patch[3], (Change::Removed, "old"));
    assert_eq!(patch[4], (Change::Added, "new"));
}

#[test]
fn markdown_draws_headings_lists_and_code() {
    let lines = markdown::lines(
        "# Title\n- first\n2. second\n> quoted\n```rust\nlet x = 1;\n```",
        40,
        "",
        Style::default(),
    );
    let texts: Vec<String> = lines.iter().map(text).collect();
    assert_eq!(
        texts,
        vec!["Title", "• first", "2. second", "│ quoted", "│ let x = 1;"]
    );
    let inline = markdown::inline("run `cargo test` **now**", Style::default());
    assert_eq!(inline[1].0, "cargo test");
    assert_eq!(inline[3].0, "now");
    assert_eq!(markdown::inline("a * b", Style::default())[0].0, "a * b");
}

#[test]
fn code_is_highlighted_in_ansi_colours() {
    let lines = highlight(&["fn main() { let name = \"memoar\"; }"], "rust");
    let string = lines[0]
        .iter()
        .find(|(text, _)| text.contains("memoar"))
        .unwrap();
    assert_eq!(string.1.fg, Some(Color::Green));
    let keyword = lines[0].iter().find(|(text, _)| text == "fn").unwrap();
    assert_eq!(keyword.1.fg, Some(Color::Magenta));
    let unknown = highlight(&["plain"], "no-such-language");
    assert_eq!(unknown[0][0].0, "plain");
}

#[test]
fn a_session_without_a_workspace_names_no_project() {
    let mut rows = rows(&page());
    for placeholder in ["/memoar/no-workspace", "/memoar/imports", ""] {
        rows[0].workspace = placeholder.to_owned();
        assert_eq!(rows[0].project(), "No workspace");
    }
    rows[0].workspace = "/workspace/memoar/".to_owned();
    assert_eq!(rows[0].project(), "memoar");
}

#[test]
fn sessions_group_under_their_day() {
    let rows = rows(&page());
    assert_eq!(rows[0].project(), "example-app");
    let today = rows[0].local_date().unwrap();
    let lines = grouped(&rows, today);
    assert_eq!(lines[0], ListLine::Day("Today".to_owned()));
    assert_eq!(lines[1], ListLine::Session(0));
    assert!(matches!(
        lines
            .iter()
            .filter(|line| matches!(line, ListLine::Day(_)))
            .count(),
        2 | 3
    ));
    let day = NaiveDate::from_ymd_opt(2026, 8, 20).unwrap();
    assert_eq!(day_label(day.pred_opt(), day), "Yesterday");
    assert_eq!(plural(1, "turn", "turns"), "1 turn");
    assert_eq!(plural(2, "turn", "turns"), "2 turns");
}

#[test]
fn the_list_window_keeps_the_selection_in_view() {
    let lines: Vec<ListLine> = std::iter::once(ListLine::Day("Today".to_owned()))
        .chain((0..20).map(ListLine::Session))
        .collect();
    let top = window(&lines, 1, 0, 10, true);
    assert_eq!((top.offset, top.start), (0, 1));
    let down = window(&lines, 15, 0, 10, true);
    assert!(down.start <= 15);
    let shown: usize = (down.start..=15).map(|_| 2).sum();
    assert!(shown <= down.rows);
    let back = window(&lines, 5, down.offset, 10, true);
    assert_eq!(back.offset, 5, "scrolling up moves only as far as needed");
}
