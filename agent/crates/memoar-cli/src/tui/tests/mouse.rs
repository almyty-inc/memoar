//! The wheel and clicks, at the positions the panes are drawn.

use ratatui::crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

use super::fixtures::{FIRST, SECOND, THIRD};
use super::{deliver_transcript, loaded, screen};
use crate::tui::app::Screen;
use crate::tui::mouse::handle;
use crate::tui::navigate::fetch_preview;

fn at(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
    MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    }
}

#[test]
fn the_wheel_moves_the_list_under_the_pointer() {
    let mut app = loaded(120, 32);
    handle(&mut app, at(MouseEventKind::ScrollDown, 5, 5));
    assert_eq!(app.sessions.selected, 1);
    assert_eq!(app.transcript.as_ref().unwrap().session.id, SECOND);
    handle(&mut app, at(MouseEventKind::ScrollUp, 5, 5));
    assert_eq!(app.sessions.selected, 0);
}

#[test]
fn the_wheel_scrolls_the_transcript_under_the_pointer() {
    let mut app = loaded(120, 16);
    fetch_preview(&mut app);
    deliver_transcript(&mut app, FIRST);
    handle(&mut app, at(MouseEventKind::ScrollDown, 80, 8));
    assert_eq!(app.transcript.as_ref().unwrap().scroll, 3);
    assert_eq!(app.sessions.selected, 0, "the list stays put");
}

#[test]
fn a_click_selects_a_row_and_a_click_on_the_transcript_focuses_it() {
    let mut app = loaded(120, 32);
    let frame = screen(&app);
    let row = frame
        .lines()
        .position(|line| line.contains("Write release notes"))
        .unwrap() as u16;
    handle(
        &mut app,
        at(MouseEventKind::Down(MouseButton::Left), 10, row),
    );
    assert_eq!(app.sessions.current().unwrap().id, THIRD);
    handle(
        &mut app,
        at(MouseEventKind::Down(MouseButton::Left), 80, 10),
    );
    assert_eq!(app.screen(), Screen::Transcript);
    handle(&mut app, at(MouseEventKind::Down(MouseButton::Left), 10, 2));
    assert_eq!(app.screen(), Screen::Sessions);
}
