mod colour;
mod fixtures;
mod mouse;
mod palette;
mod pieces;
mod render;
mod state;
mod worker;

use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use super::app::App;
use super::request::{Request, Response};
use super::{draw, keys, update};

/// An app holding the fixture page, at a size, with no network.
pub(super) fn loaded(width: u16, height: u16) -> App {
    let mut app = App::new("https://archive.example.test/v1");
    app.width = width;
    app.height = height;
    update::apply(
        &mut app,
        Response::Sessions {
            cursor: None,
            result: Ok(fixtures::page()),
        },
    );
    app
}

pub(super) fn press(app: &mut App, code: KeyCode) -> Vec<Request> {
    keys::handle(app, KeyEvent::new(code, KeyModifiers::NONE))
}

pub(super) fn control(app: &mut App, character: char) -> Vec<Request> {
    keys::handle(
        app,
        KeyEvent::new(KeyCode::Char(character), KeyModifiers::CONTROL),
    )
}

pub(super) fn release(app: &mut App, code: KeyCode) -> Vec<Request> {
    let mut key = KeyEvent::new(code, KeyModifiers::NONE);
    key.kind = KeyEventKind::Release;
    keys::handle(app, key)
}

pub(super) fn typed(app: &mut App, text: &str) {
    for character in text.chars() {
        press(app, KeyCode::Char(character));
    }
}

/// The fixture transcript arriving for the previewed session.
pub(super) fn deliver_transcript(app: &mut App, id: &str) -> Vec<Request> {
    update::apply(
        app,
        Response::Transcript {
            session_id: id.to_owned(),
            cursor: None,
            result: Ok(fixtures::chunk(id)),
        },
    )
}

/// The frame as text, one line per row, trailing spaces trimmed.
pub(super) fn screen(app: &App) -> String {
    let mut terminal = Terminal::new(TestBackend::new(app.width, app.height)).unwrap();
    super::navigate::settle(app);
    terminal.draw(|frame| draw::draw(frame, app)).unwrap();
    let buffer = terminal.backend().buffer().clone();
    let mut out = String::new();
    for y in 0..buffer.area.height {
        let mut line = String::new();
        for x in 0..buffer.area.width {
            line.push_str(buffer[(x, y)].symbol());
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}
