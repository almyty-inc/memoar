//! The title bar the app draws in place of the system's, so the window reads
//! as one surface: the traffic lights on macOS, the caption buttons on
//! Windows and GTK's window controls stay where each desktop puts them, and
//! the bar between them drags the window.

use nsh_core::desktop::TitleBarStyle;
use nsh_core::ui::FontWeight;
use nsh_core::ui::desktop::{set_title_bar, title_bar};
use nsh_core::ui::prelude::*;

use super::look::{hair, look};
use super::style::BASE;

/// Hides the system's title bar and returns the app's. It takes no space
/// where there is no window to put it in (headless, or a system bar).
pub(crate) fn bar() -> impl IntoElement {
    let l = look();
    set_title_bar(TitleBarStyle::Hidden, Some(px(l.header)));
    let shown = move || title_bar().top.0 > 0.0;
    when(shown, move || {
        let bar = view()
            .window_drag(true)
            .flex_row()
            .items_center()
            .h(move || title_bar().top)
            .pl(move || px(title_bar().left.0 + 12.0))
            .pr(move || px(title_bar().right.0 + 12.0))
            .border_b(px(hair()))
            .border_color(l.line);
        let bar = if l.centred_title {
            bar.justify_center()
        } else {
            bar
        };
        bar.child(
            text("Memoar")
                .text_size(px(BASE))
                .font_weight(FontWeight::SEMIBOLD),
        )
    })
}
