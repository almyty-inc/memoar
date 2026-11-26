//! Frames drawn into ratatui's TestBackend.

use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::crossterm::event::KeyCode;
use ratatui::style::Color;
use serde_json::json;

use super::fixtures::FIRST;
use super::{deliver_transcript, loaded, press, screen};
use crate::tui::draw;
use crate::tui::request::Response;
use crate::tui::update::apply;

#[test]
fn a_wide_terminal_shows_the_list_and_the_preview_side_by_side() {
    let mut app = loaded(120, 32);
    let frame = screen(&app);
    assert!(frame.contains("╭ Sessions 3 sessions"), "{frame}");
    assert!(frame.contains("Fix the importer"), "{frame}");
    assert!(
        frame.contains("Claude Code · example-app · 4 turns"),
        "{frame}"
    );
    assert!(frame.contains("Loading the transcript."), "{frame}");
    assert!(frame.contains(" sessions  j/k move  enter read"), "{frame}");
    assert!(frame.contains("archive.example.test"), "{frame}");
    deliver_transcript(&mut app, FIRST);
    let frame = screen(&app);
    for expected in [
        "You",
        "Why does the importer drop tool output?",
        "▸ thinking, t shows it",
        "│ fn parse() -> u32 { 42 }",
        "▸ Read /workspace/example-app/src/parser.rs · 3 lines",
        "$ cargo test parser",
        "│ running 1 test",
        "▸ Edit /workspace/example-app/src/parser.rs",
        "- copy_text_only()",
        "+ copy_every_field()",
    ] {
        assert!(frame.contains(expected), "missing {expected:?} in\n{frame}");
    }
    assert!(
        !frame.contains("edited"),
        "a result drawn with its call is not drawn again"
    );
}

#[test]
fn thinking_shows_when_toggled() {
    let mut app = loaded(120, 32);
    deliver_transcript(&mut app, FIRST);
    press(&mut app, KeyCode::Enter);
    press(&mut app, KeyCode::Char('t'));
    let frame = screen(&app);
    assert!(
        frame.contains("│ It probably copies only the text field."),
        "{frame}"
    );
    assert!(frame.contains("thinking shown"), "{frame}");
    assert!(!frame.contains("t shows it"), "{frame}");
}

#[test]
fn a_narrow_terminal_shows_one_pane_at_a_time() {
    let mut app = loaded(80, 24);
    let frame = screen(&app);
    assert!(frame.contains("Sessions"));
    assert!(!frame.contains("Loading the transcript."), "{frame}");
    press(&mut app, KeyCode::Enter);
    let frame = screen(&app);
    assert!(!frame.contains("╭ Sessions"), "{frame}");
    assert!(frame.contains("Loading the transcript."), "{frame}");
}

#[test]
fn a_tiny_terminal_says_how_big_to_make_it() {
    let app = loaded(30, 6);
    let frame = screen(&app);
    assert!(frame.contains("Make the terminal at least 40"), "{frame}");
}

#[test]
fn every_size_draws_without_panicking() {
    let mut app = loaded(120, 32);
    deliver_transcript(&mut app, FIRST);
    for (width, height) in [(1, 1), (40, 10), (41, 11), (95, 30), (96, 30), (200, 60)] {
        app.width = width;
        app.height = height;
        for key in [
            KeyCode::Enter,
            KeyCode::Char('t'),
            KeyCode::Char(':'),
            KeyCode::Esc,
            KeyCode::Esc,
        ] {
            screen(&app);
            press(&mut app, key);
        }
    }
}

#[test]
fn a_diff_is_drawn_in_green_and_red() {
    let mut app = loaded(120, 40);
    deliver_transcript(&mut app, FIRST);
    let mut terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
    terminal.draw(|frame| draw::draw(frame, &app)).unwrap();
    let buffer = terminal.backend().buffer();
    let find = |needle: &str| {
        (0..buffer.area.height).find_map(|y| {
            let line: String = (0..buffer.area.width)
                .map(|x| buffer[(x, y)].symbol())
                .collect();
            line.find(needle)
                .map(|byte| (line[..byte].chars().count() as u16, y))
        })
    };
    let (x, y) = find("+ copy_every_field").unwrap();
    assert_eq!(buffer[(x, y)].fg, Color::Green);
    let (x, y) = find("- copy_text_only").unwrap();
    assert_eq!(buffer[(x, y)].fg, Color::Red);
}

#[test]
fn the_palette_lists_what_it_matches() {
    let mut app = loaded(120, 32);
    press(&mut app, KeyCode::Char(':'));
    super::typed(&mut app, "export");
    let frame = screen(&app);
    assert!(frame.contains("Commands"), "{frame}");
    assert!(frame.contains("Export session"), "{frame}");
    assert!(frame.contains(" palette "), "{frame}");
}

#[test]
fn status_without_a_service_is_advice_not_a_fault() {
    let mut app = loaded(100, 30);
    press(&mut app, KeyCode::Char('s'));
    apply(
        &mut app,
        Response::Status(Ok(json!({
            "backgroundCapture": {
                "state": "not_running", "ok": false,
                "summary": "background capture is not running",
                "hint": "Run `memoar service install` to keep capture running."
            },
            "service": { "installed": false, "manager": "launchd" },
            "endpoint": "https://archive.example.test/v1",
            "machineId": "0198d8d0-977c-777b-9f8f-0f6d8416e700",
            "queue": { "pending": 2, "retry": 0, "synced": 40, "held": 1 },
            "disk": { "ok": true, "detail": "100 GB free, capture keeps 1 GB free" },
            "detectedSources": 2, "sourceCount": 9,
            "redaction": { "secrets": true, "emailAddresses": false, "homePaths": false }
        }))),
    );
    let frame = screen(&app);
    for expected in [
        "╭ Capture status",
        "Capture     background capture is not running",
        "Service     not installed. It is optional",
        "Queue       2 waiting, 0 retrying, 40 uploaded, 1 held",
        "Sources     2 of 9 sources detected",
        "Redaction   secrets",
        " status  r refresh",
    ] {
        assert!(frame.contains(expected), "missing {expected:?} in\n{frame}");
    }
}
