//! The command palette and its fuzzy matching.

use ratatui::crossterm::event::KeyCode;

use super::fixtures::{FIRST, THIRD};
use super::{control, loaded, press, typed};
use crate::tui::action::Action;
use crate::tui::app::{Overlay, Screen};
use crate::tui::fuzzy::score;
use crate::tui::palette::items;
use crate::tui::request::Request;

#[test]
fn fuzzy_matching_prefers_word_starts_and_runs() {
    assert!(score("rn", "Write release notes").is_some());
    assert!(score("xyz", "Write release notes").is_none());
    let (start, _) = score("fix", "Fix the importer").unwrap();
    let (scattered, _) = score("fix", "a prefix x").unwrap();
    assert!(start > scattered);
    assert_eq!(score("", "anything"), Some((0, Vec::new())));
    assert_eq!(score("wr", "Write").unwrap().1, vec![0, 1]);
}

#[test]
fn colon_and_control_p_open_it() {
    let mut app = loaded(120, 32);
    press(&mut app, KeyCode::Char(':'));
    assert!(matches!(app.overlay, Some(Overlay::Palette { .. })));
    press(&mut app, KeyCode::Esc);
    assert!(app.overlay.is_none());
    control(&mut app, 'p');
    assert!(matches!(app.overlay, Some(Overlay::Palette { .. })));
}

#[test]
fn it_lists_actions_and_sessions_and_offers_a_search() {
    let app = loaded(120, 32);
    let found = items(&app, "notes");
    assert_eq!(found[0].action, Action::Jump(THIRD.to_owned()));
    assert_eq!(
        found.last().unwrap().action,
        Action::SearchFor("notes".to_owned())
    );
    let codex = items(&app, "codex");
    assert_eq!(codex[0].action, Action::Convert("codex"));
    assert_eq!(codex[0].key, "c");
}

#[test]
fn enter_runs_the_chosen_item() {
    let mut app = loaded(120, 32);
    press(&mut app, KeyCode::Char(':'));
    typed(&mut app, "notes");
    press(&mut app, KeyCode::Enter);
    assert!(app.overlay.is_none());
    assert_eq!(app.sessions.current().unwrap().id, THIRD);

    press(&mut app, KeyCode::Char(':'));
    typed(&mut app, "copy id");
    let requests = press(&mut app, KeyCode::Enter);
    assert_eq!(
        requests,
        vec![Request::Copy {
            text: THIRD.to_owned()
        }]
    );

    press(&mut app, KeyCode::Char('g'));
    press(&mut app, KeyCode::Char(':'));
    typed(&mut app, "importer bug");
    press(&mut app, KeyCode::Up);
    let found = match &app.overlay {
        Some(Overlay::Palette { input, .. }) => items(&app, input),
        _ => panic!("palette closed"),
    };
    assert_eq!(
        found.last().unwrap().action,
        Action::SearchFor("importer bug".to_owned())
    );
    for _ in 0..found.len() {
        press(&mut app, KeyCode::Down);
    }
    let requests = press(&mut app, KeyCode::Enter);
    assert_eq!(app.screen(), Screen::Search);
    assert_eq!(
        requests,
        vec![Request::Search {
            query: "importer bug".to_owned(),
            cursor: None
        }]
    );
    assert_eq!(app.sessions.current().unwrap().id, FIRST);
}
