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
    let mut spans = Vec::new();
    let mut used = 0;
    // The pane in the top left corner carries the name, as a window's title
    // bar would: the thread in the logo's blue, then the wordmark.
    if area.x == 0 && area.y == 0 && room > 24 {
        let glyphs = style::glyphs();
        spans.push(Span::styled(
            format!(" {} ", glyphs.thread),
            ratatui::style::Style::default().fg(crate::tui::colour::brand()),
        ));
        spans.push(Span::styled("memoar ", style::bold()));
        spans.push(Span::styled(format!("{} ", glyphs.separator), style::dim()));
        used +=
            10 + crate::tui::text::width(glyphs.thread) + crate::tui::text::width(glyphs.separator);
    }
    let title = truncate(title, room.saturating_sub(used + 2));
    let lead = if spans.is_empty() { " " } else { "" };
    spans.push(Span::styled(format!("{lead}{title} "), title_style));
    used += crate::tui::text::width(&title) + 2;
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
