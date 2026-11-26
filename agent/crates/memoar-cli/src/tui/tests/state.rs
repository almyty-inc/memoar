//! The state machine: keys in, requests out, answers applied.

use ratatui::crossterm::event::KeyCode;
use serde_json::json;

use super::fixtures::{FIRST, SECOND, THIRD, chunk};
use super::{control, deliver_transcript, loaded, press, release, typed};
use crate::error::AppError;
use crate::tui::app::{Overlay, Screen, SearchFocus};
use crate::tui::navigate::fetch_preview;
use crate::tui::request::{Request, Response};
use crate::tui::update::apply;

#[test]
fn the_first_session_is_previewed_once_the_selection_rests() {
    let mut app = loaded(120, 32);
    assert_eq!(app.sessions.rows.len(), 3);
    assert_eq!(app.transcript.as_ref().unwrap().session.id, FIRST);
    assert!(app.preview_pending);
    assert_eq!(
        fetch_preview(&mut app),
        vec![Request::Transcript {
            session_id: FIRST.to_owned(),
            cursor: None
        }]
    );
    assert!(fetch_preview(&mut app).is_empty(), "asked for once");
}

#[test]
fn moving_the_selection_moves_the_preview_and_keeps_what_was_read() {
    let mut app = loaded(120, 32);
    fetch_preview(&mut app);
    deliver_transcript(&mut app, FIRST);
    assert!(
        press(&mut app, KeyCode::Char('j')).is_empty(),
        "no fetch while moving"
    );
    assert_eq!(app.sessions.selected, 1);
    assert_eq!(app.transcript.as_ref().unwrap().session.id, SECOND);
    assert!(app.viewed.contains_key(FIRST));
    press(&mut app, KeyCode::Up);
    assert_eq!(
        app.transcript.as_ref().unwrap().turns.len(),
        3,
        "from memory"
    );
    assert!(!app.preview_pending);
    press(&mut app, KeyCode::Char('G'));
    assert_eq!(app.sessions.selected, 2);
    press(&mut app, KeyCode::Char('j'));
    assert_eq!(app.sessions.selected, 2, "stops at the end");
}

#[test]
fn a_transcript_that_arrives_after_moving_on_is_kept_for_later() {
    let mut app = loaded(120, 32);
    fetch_preview(&mut app);
    press(&mut app, KeyCode::Down);
    assert!(deliver_transcript(&mut app, FIRST).is_empty());
    assert_eq!(app.viewed[FIRST].turns.len(), 3);
    press(&mut app, KeyCode::Up);
    assert!(fetch_preview(&mut app).is_empty());
}

#[test]
fn key_releases_and_repeats_from_windows_are_not_presses() {
    let mut app = loaded(120, 32);
    assert!(release(&mut app, KeyCode::Char('j')).is_empty());
    assert_eq!(app.sessions.selected, 0);
}

#[test]
fn enter_reads_the_session_and_escape_comes_back() {
    let mut app = loaded(120, 32);
    let requests = press(&mut app, KeyCode::Enter);
    assert_eq!(app.screen(), Screen::Transcript);
    assert_eq!(
        requests,
        vec![Request::Transcript {
            session_id: FIRST.to_owned(),
            cursor: None
        }]
    );
    press(&mut app, KeyCode::Char('t'));
    assert!(app.show_thinking);
    press(&mut app, KeyCode::Esc);
    assert_eq!(app.screen(), Screen::Sessions);
    assert!(!app.quit);
    press(&mut app, KeyCode::Char('q'));
    assert!(app.quit);
}

#[test]
fn control_c_quits_from_anywhere() {
    let mut app = loaded(120, 32);
    press(&mut app, KeyCode::Char('/'));
    control(&mut app, 'c');
    assert!(app.quit);
}

#[test]
fn convert_offers_targets_and_reports_the_resume_command() {
    let mut app = loaded(120, 32);
    press(&mut app, KeyCode::Char('c'));
    assert!(matches!(app.overlay, Some(Overlay::ConvertPicker { .. })));
    let requests = press(&mut app, KeyCode::Char('2'));
    assert_eq!(
        requests,
        vec![Request::Convert {
            session_id: FIRST.to_owned(),
            target: "codex".to_owned()
        }]
    );
    assert_eq!(app.converting, vec![FIRST.to_owned()]);
    apply(
        &mut app,
        Response::Converted {
            session_id: FIRST.to_owned(),
            target: "codex".to_owned(),
            result: Ok(
                json!({ "written": ["a", "b"], "unchanged": [], "resumeCommand": "codex resume x" }),
            ),
        },
    );
    assert!(app.converting.is_empty());
    let Some(Overlay::Message { title, lines }) = &app.overlay else {
        panic!("no message");
    };
    assert_eq!(title, "Converted for Codex");
    assert!(lines.contains(&"$ codex resume x".to_owned()));
    assert!(lines[0].starts_with("2 files written"));
    press(&mut app, KeyCode::Char('x'));
    assert!(app.overlay.is_none());
}

#[test]
fn a_refused_conversion_says_why_and_writes_nothing() {
    let mut app = loaded(120, 32);
    let refusal = AppError::refused(
        "MEMOAR_CLOBBER",
        "a different file is already there",
        "Move it.",
    );
    apply(
        &mut app,
        Response::Converted {
            session_id: FIRST.to_owned(),
            target: "claude-code".to_owned(),
            result: Err(refusal),
        },
    );
    let Some(Overlay::Message { title, lines }) = &app.overlay else {
        panic!("no message");
    };
    assert_eq!(title, "Not converted for Claude Code");
    assert_eq!(lines[0], "a different file is already there");
}

#[test]
fn export_and_copy_act_on_the_selected_session() {
    let mut app = loaded(120, 32);
    press(&mut app, KeyCode::Down);
    assert_eq!(
        press(&mut app, KeyCode::Char('e')),
        vec![Request::Export {
            session_id: SECOND.to_owned()
        }]
    );
    assert_eq!(
        press(&mut app, KeyCode::Char('y')),
        vec![Request::Copy {
            text: SECOND.to_owned()
        }]
    );
}

#[test]
fn search_types_runs_and_ignores_stale_answers() {
    let mut app = loaded(120, 32);
    press(&mut app, KeyCode::Char('/'));
    assert_eq!(app.screen(), Screen::Search);
    typed(&mut app, "quit");
    assert_eq!(
        app.search.input, "quit",
        "q types while the query has the keys"
    );
    let requests = press(&mut app, KeyCode::Enter);
    assert_eq!(
        requests,
        vec![Request::Search {
            query: "quit".to_owned(),
            cursor: None
        }]
    );
    assert_eq!(app.search.focus, SearchFocus::Results);
    apply(
        &mut app,
        Response::Search {
            query: "older".to_owned(),
            cursor: None,
            result: Ok(super::fixtures::page()),
        },
    );
    assert!(
        app.search.results.rows.is_empty(),
        "an answer to another query"
    );
    let mut page = super::fixtures::page();
    page["items"].as_array_mut().unwrap().remove(0);
    page["meta"] = json!({ "realizedMode": "lexical" });
    apply(
        &mut app,
        Response::Search {
            query: "quit".to_owned(),
            cursor: None,
            result: Ok(page),
        },
    );
    assert_eq!(app.search.results.rows[0].id, SECOND);
    assert_eq!(
        app.transcript.as_ref().unwrap().session.id,
        SECOND,
        "preview follows results"
    );
    press(&mut app, KeyCode::Char('j'));
    assert_eq!(app.transcript.as_ref().unwrap().session.id, THIRD);
    press(&mut app, KeyCode::Esc);
    assert_eq!(app.screen(), Screen::Sessions);
}

#[test]
fn status_is_asked_for_and_left_with_escape() {
    let mut app = loaded(120, 32);
    assert_eq!(press(&mut app, KeyCode::Char('s')), vec![Request::Status]);
    assert_eq!(app.screen(), Screen::Status);
    press(&mut app, KeyCode::Esc);
    assert_eq!(app.screen(), Screen::Sessions);
}

#[test]
fn offline_keeps_what_is_on_screen_and_says_so() {
    let mut app = loaded(120, 32);
    apply(
        &mut app,
        Response::Sessions {
            cursor: None,
            result: Err(AppError::network("connection refused")),
        },
    );
    assert!(app.offline);
    assert_eq!(app.sessions.rows.len(), 3);
    assert!(
        app.notice
            .as_ref()
            .unwrap()
            .text
            .contains("connection refused")
    );
    apply(
        &mut app,
        Response::Sessions {
            cursor: None,
            result: Ok(super::fixtures::page()),
        },
    );
    assert!(!app.offline);
}

#[test]
fn a_long_transcript_scrolls_and_asks_for_the_next_chunk() {
    let mut app = loaded(120, 20);
    press(&mut app, KeyCode::Enter);
    let mut long = chunk(FIRST);
    let turns = long["turns"].as_array().unwrap().clone();
    let many: Vec<_> = (0..20).flat_map(|_| turns.clone()).collect();
    long["turns"] = json!(many);
    long["nextCursor"] = json!("next");
    let follow = apply(
        &mut app,
        Response::Transcript {
            session_id: FIRST.to_owned(),
            cursor: None,
            result: Ok(long),
        },
    );
    assert!(follow.is_empty(), "the first chunk fills the screen");
    press(&mut app, KeyCode::Char('j'));
    assert_eq!(app.transcript.as_ref().unwrap().scroll, 1);
    let requests = press(&mut app, KeyCode::Char('G'));
    assert_eq!(
        requests,
        vec![Request::Transcript {
            session_id: FIRST.to_owned(),
            cursor: Some("next".to_owned())
        }]
    );
    press(&mut app, KeyCode::Char('g'));
    assert_eq!(app.transcript.as_ref().unwrap().scroll, 0);
}
