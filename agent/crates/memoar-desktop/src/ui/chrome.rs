//! The title bar the app draws in place of the system's, so the window reads
//! as one surface: the product field runs up under the traffic lights on
//! macOS, the caption buttons on Windows and GTK's window controls, which
//! stay where each desktop puts them. The bar carries the memoar wordmark and
//! drags the window.

use nsh_core::desktop::TitleBarStyle;
use nsh_core::ui::desktop::{set_title_bar, title_bar};
use nsh_core::ui::prelude::*;

use super::brand::wordmark;
use super::look::look;

/// Hides the system's title bar and returns the app's. It takes no space
/// where there is no window to put it in (headless, or a system bar).
pub(crate) fn bar() -> impl IntoElement {
    let l = look();
    set_title_bar(TitleBarStyle::Hidden, Some(px(l.header)));
    let shown = move || title_bar().top.0 > 0.0;
    // A centred title is centred in the window, so both sides reserve the
    // wider of the two control areas.
    let side =
        move |own: f32, other: f32| px(if l.centred_title { own.max(other) } else { own } + 14.0);
    when(shown, move || {
        let bar = view()
            .window_drag(true)
            .flex_row()
            .items_center()
            .h(move || title_bar().top)
            .pl(move || side(title_bar().left.0, title_bar().right.0))
            .pr(move || side(title_bar().right.0, title_bar().left.0));
        let bar = if l.centred_title {
            bar.justify_center()
        } else {
            bar
        };
        bar.child(wordmark(15.0))
    })
}
