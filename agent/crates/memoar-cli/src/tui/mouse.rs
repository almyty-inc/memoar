//! The mouse, for those who reach for it: the wheel scrolls the pane under
//! the pointer and a click selects a row or focuses the transcript. Every
//! one of these has a key, so nothing needs a mouse.

use ratatui::crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::{Position, Rect};

use super::app::{App, Screen};
use super::draw::list::hit;
use super::draw::screens_lines;
use super::layout::{app_panes, list_rows};
use super::navigate::{open, scroll_transcript, select};
use super::request::Request;

/// Lines one notch of the wheel moves a transcript.
const WHEEL_LINES: isize = 3;

pub(crate) fn handle(app: &mut App, event: MouseEvent) -> Vec<Request> {
    if app.overlay.is_some() || app.screen() == Screen::Status {
        return Vec::new();
    }
    let panes = app_panes(app);
    let at = Position::new(event.column, event.row);
    let inside = |pane: Option<Rect>| pane.is_some_and(|pane| pane.contains(at));
    let on_list = inside(panes.list);
    let on_detail = inside(panes.detail);
    match event.kind {
        MouseEventKind::ScrollDown if on_detail => scroll_transcript(app, WHEEL_LINES),
        MouseEventKind::ScrollUp if on_detail => scroll_transcript(app, -WHEEL_LINES),
        MouseEventKind::ScrollDown if on_list => {
            let next = app.list().selected + 1;
            select(app, next)
        }
        MouseEventKind::ScrollUp if on_list => {
            let previous = app.list().selected.saturating_sub(1);
            select(app, previous)
        }
        MouseEventKind::Down(MouseButton::Left) if on_detail => {
            if app.screen() == Screen::Transcript {
                Vec::new()
            } else {
                open(app)
            }
        }
        MouseEventKind::Down(MouseButton::Left) if on_list => {
            if app.screen() == Screen::Transcript {
                app.back();
            }
            let Some(pane) = panes.list else {
                return Vec::new();
            };
            let rows = list_rows(pane, app.list_screen());
            let lines = screens_lines(app);
            match hit(app.list(), &lines, rows, event.row) {
                Some(index) => select(app, index),
                None => Vec::new(),
            }
        }
        _ => Vec::new(),
    }
}
