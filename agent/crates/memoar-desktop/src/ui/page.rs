//! One screen inside the card: a body that scrolls, and the screen's buttons
//! pinned below it.
//!
//! The window opens at 560 by 680 points and the platforms do not let the
//! packaged app ask for more. With the buttons inside the scrolled body, the
//! last of them sat under the card's foot on every platform: "Sign in" half
//! hidden, "Open web app" and "Sign out" out of sight on macOS. Pinned, they
//! show whatever the window's height.

use nsh_core::ui::prelude::*;

use super::look::{self, look};

fn body(content: impl IntoElement) -> impl IntoElement {
    scroll()
        .flex_1()
        .child(view().px(px(32.0)).pt(px(26.0)).pb(px(16.0)).child(content))
}

/// A screen with nothing to press.
pub(crate) fn page(content: impl IntoElement) -> View {
    view().flex_1().child(body(content))
}

/// A screen whose `actions` stay in view while `content` scrolls.
pub(crate) fn page_with(content: impl IntoElement, actions: impl IntoElement) -> View {
    let l = look();
    view().flex_1().child(body(content)).child(
        view()
            .px(px(32.0))
            .py(px(12.0))
            .border_t(px(look::hair()))
            .border_color(l.rule)
            .child(actions),
    )
}
