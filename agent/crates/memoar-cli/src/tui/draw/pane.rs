//! A bordered pane. The one with the keys has its border and title in the
//! accent, so where the keys go is never a guess.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::Block;

use crate::tui::style;
use crate::tui::text::truncate;

/// Draws the border with `title` and plain-text `facts` in it, and returns
/// the area inside.
pub(super) fn frame_pane(
    frame: &mut Frame,
    area: Rect,
    title: &str,
    facts: &[String],
    focused: bool,
) -> Rect {
    let border_style = if focused {
        style::accent()
    } else {
        style::dim()
    };
    let title_style = if focused {
        style::accent().add_modifier(ratatui::style::Modifier::BOLD)
    } else {
        style::bold()
    };
    let room = usize::from(area.width.saturating_sub(4));
    let title = truncate(title, room);
    let mut spans = vec![Span::styled(format!(" {title} "), title_style)];
    let mut used = crate::tui::text::width(&title) + 2;
    for fact in facts.iter().filter(|fact| !fact.is_empty()) {
        let text = format!("{fact} ");
        let size = crate::tui::text::width(&text);
        if used + size > room {
            break;
        }
        used += size;
        spans.push(Span::styled(text, style::dim()));
    }
    let block = Block::bordered()
        .border_set(style::glyphs().border)
        .border_style(border_style)
        .title(Line::from(spans));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    inner
}
