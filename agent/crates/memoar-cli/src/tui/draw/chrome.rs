//! The notice line and the status bar: which pane has the keys, what the
//! keys do there, and where the archive is.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

use crate::tui::app::{App, NoticeKind, Overlay, Screen, SearchFocus};
use crate::tui::style;
use crate::tui::text::{truncate, width};

pub(super) fn notice(frame: &mut Frame, app: &App, area: Rect) {
    let Some(notice) = &app.notice else {
        return;
    };
    let line_style = match notice.kind {
        NoticeKind::Info => style::plain(),
        NoticeKind::Error => style::removed(),
    };
    let text = truncate(&format!(" {}", notice.text), usize::from(area.width));
    frame.render_widget(Paragraph::new(Line::styled(text, line_style)), area);
}

pub(super) fn bar(frame: &mut Frame, app: &App, area: Rect) {
    let mode = format!(" {} ", mode(app));
    let right = if app.offline {
        "offline ".to_owned()
    } else {
        format!("{} ", host(&app.endpoint))
    };
    let room = usize::from(area.width).saturating_sub(width(&mode) + width(&right) + 2);
    let hints = truncate(hint_text(app), room);
    let gap = room.saturating_sub(width(&hints));
    let right_style = if app.offline {
        style::removed()
    } else {
        style::dim()
    };
    let line = Line::from(vec![
        Span::styled(mode, style::selected()),
        Span::raw(" "),
        Span::styled(hints, style::dim()),
        Span::raw(" ".repeat(gap + 1)),
        Span::styled(right, right_style),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}

fn mode(app: &App) -> &'static str {
    match &app.overlay {
        Some(Overlay::Palette { .. }) => return "palette",
        Some(Overlay::ConvertPicker { .. }) => return "convert",
        Some(Overlay::Message { .. }) => return "done",
        None => {}
    }
    match app.screen() {
        Screen::Sessions => "sessions",
        Screen::Search => "search",
        Screen::Transcript => "transcript",
        Screen::Status => "status",
    }
}

fn host(endpoint: &str) -> &str {
    let rest = endpoint
        .split_once("://")
        .map_or(endpoint, |(_, rest)| rest);
    rest.split('/').next().unwrap_or(rest)
}

pub(crate) fn hint_text(app: &App) -> &'static str {
    match &app.overlay {
        Some(Overlay::Palette { .. }) => {
            return "type to filter  up/down choose  enter run  esc close";
        }
        Some(Overlay::ConvertPicker { .. }) => {
            return "j/k choose  1-3 pick  enter convert  esc cancel";
        }
        Some(Overlay::Message { lines, .. }) if lines.iter().any(|line| line.starts_with("$ ")) => {
            return "y copies the command  any other key closes";
        }
        Some(Overlay::Message { .. }) => return "any key closes",
        None => {}
    }
    match app.screen() {
        Screen::Sessions => {
            "j/k move  enter read  : commands  / search  c convert  e export  y copy id  s status  q quit"
        }
        Screen::Transcript => {
            "j/k scroll  space page  g/G ends  t thinking  c convert  e export  y copy id  esc back"
        }
        Screen::Search if app.search.focus == SearchFocus::Input => {
            "type a query  enter search  down results  esc back"
        }
        Screen::Search => {
            "j/k move  enter read  / edit query  : commands  c convert  e export  esc back"
        }
        Screen::Status => "r refresh  : commands  esc back",
    }
}
