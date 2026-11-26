//! Turns the state into a frame. Reads `App`, never changes what it means.

mod chrome;
pub(crate) mod list;
mod overlay;
mod pane;
mod screens;
mod status;

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::text::Line;
use ratatui::widgets::{Paragraph, Wrap};

use super::app::{App, Screen};
use super::layout::{MIN_HEIGHT, MIN_WIDTH, panes, too_small};
use super::style;

pub(crate) fn draw(frame: &mut Frame, app: &App) {
    let area = frame.area();
    if too_small(area.width, area.height) {
        small(frame, area);
        return;
    }
    let screen = app.screen();
    let panes = panes(screen, area);
    if let Some(pane) = panes.list {
        screens::list(frame, app, pane, screen != Screen::Transcript);
    }
    if let Some(pane) = panes.detail {
        screens::transcript(frame, app, pane, screen == Screen::Transcript);
    }
    if let Some(pane) = panes.status {
        status::draw(frame, app, pane);
    }
    chrome::notice(frame, app, panes.notice);
    chrome::bar(frame, app, panes.bar);
    if let Some(overlay) = &app.overlay {
        overlay::draw(frame, app, overlay, area);
    }
}

/// The lines of the list beside the transcript, as drawn.
pub(crate) fn screens_lines(app: &App) -> Vec<super::model::ListLine> {
    if app.list_screen() == Screen::Search {
        screens::search_lines(app)
    } else {
        screens::session_lines(app)
    }
}

fn small(frame: &mut Frame, area: Rect) {
    let text = format!("Make the terminal at least {MIN_WIDTH} columns by {MIN_HEIGHT} lines.");
    frame.render_widget(
        Paragraph::new(Line::styled(text, style::dim())).wrap(Wrap { trim: true }),
        area,
    );
}
