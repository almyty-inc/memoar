//! Where things go on screen. Shared by `draw`, `keys` and `mouse`, so a
//! page down moves exactly as far as a page is tall and a click lands on
//! the row it was aimed at.
//!
//! Wide terminals show the list and the selected transcript side by side.
//! Narrow ones show whichever has the keys. The bottom two lines are the
//! notice and the status bar.

use ratatui::layout::{Margin, Rect};

use super::app::{App, Screen};

pub(crate) const MIN_WIDTH: u16 = 40;
pub(crate) const MIN_HEIGHT: u16 = 10;
/// Below this width the list and the transcript take turns.
pub(crate) const SPLIT_WIDTH: u16 = 96;

pub(crate) fn too_small(width: u16, height: u16) -> bool {
    width < MIN_WIDTH || height < MIN_HEIGHT
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Panes {
    pub(crate) list: Option<Rect>,
    pub(crate) detail: Option<Rect>,
    pub(crate) status: Option<Rect>,
    pub(crate) notice: Rect,
    pub(crate) bar: Rect,
}

pub(crate) fn panes(screen: Screen, area: Rect) -> Panes {
    let bottom = area.y + area.height;
    let body = Rect::new(area.x, area.y, area.width, area.height.saturating_sub(2));
    let mut panes = Panes {
        list: None,
        detail: None,
        status: None,
        notice: Rect::new(area.x, bottom.saturating_sub(2), area.width, 1),
        bar: Rect::new(area.x, bottom.saturating_sub(1), area.width, 1),
    };
    if screen == Screen::Status {
        panes.status = Some(body);
    } else if area.width >= SPLIT_WIDTH {
        let left = (area.width * 2 / 5).clamp(44, 72);
        panes.list = Some(Rect::new(body.x, body.y, left, body.height));
        panes.detail = Some(Rect::new(
            body.x + left,
            body.y,
            body.width - left,
            body.height,
        ));
    } else if screen == Screen::Transcript {
        panes.detail = Some(body);
    } else {
        panes.list = Some(body);
    }
    panes
}

pub(crate) fn app_panes(app: &App) -> Panes {
    panes(app.screen(), Rect::new(0, 0, app.width, app.height))
}

/// Inside a pane's border.
pub(crate) fn inner(pane: Rect) -> Rect {
    pane.inner(Margin::new(1, 1))
}

/// Where the list's rows go: under the query line in a search.
pub(crate) fn list_rows(pane: Rect, list_screen: Screen) -> Rect {
    let inner = inner(pane);
    if list_screen == Screen::Search {
        let skip = 2.min(inner.height);
        Rect::new(inner.x, inner.y + skip, inner.width, inner.height - skip)
    } else {
        inner
    }
}

/// Where the transcript's text goes: under its meta line, a column in from
/// each border.
pub(crate) fn transcript_text(pane: Rect) -> Rect {
    let inner = inner(pane);
    let skip = 2.min(inner.height);
    Rect::new(
        inner.x + 1,
        inner.y + skip,
        inner.width.saturating_sub(2),
        inner.height - skip,
    )
}

/// The transcript's text area for the current state, focused or not.
pub(crate) fn transcript_area(app: &App) -> Rect {
    let panes = panes(Screen::Transcript, Rect::new(0, 0, app.width, app.height));
    panes.detail.map(transcript_text).unwrap_or_default()
}

/// How many lines a list shows.
pub(crate) fn list_height(app: &App) -> usize {
    let screen = app.list_screen();
    let panes = panes(screen, Rect::new(0, 0, app.width, app.height));
    panes
        .list
        .map_or(1, |pane| usize::from(list_rows(pane, screen).height).max(1))
}
