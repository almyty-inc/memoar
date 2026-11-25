//! The window: one screen for signing in, one for everything after.

mod sign_in;
mod status;
mod style;

use nsh_base::{safe_area_view, theme};
use nsh_core::ui::prelude::*;

use crate::controller::Controller;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Screen {
    Fatal,
    Loading,
    SignIn,
    Status,
}

fn screen_of(ctl: Controller) -> Screen {
    if ctl.fatal.get().is_some() {
        Screen::Fatal
    } else {
        match ctl.status.get() {
            None => Screen::Loading,
            Some(status) if status.signed_in => Screen::Status,
            Some(_) => Screen::SignIn,
        }
    }
}

pub(crate) fn root(ctl: Controller) -> impl IntoElement {
    let screen = computed(move || screen_of(ctl));
    view()
        .flex_1()
        .bg(move || theme().background)
        .text_color(move || theme().foreground)
        .child(
            safe_area_view().flex_1().child(
                scroll().flex_1().child(
                    view()
                        .p_6()
                        .gap_4()
                        .child(when(
                            move || screen.get() == Screen::Fatal,
                            move || {
                                style::note(move || {
                                    format!(
                                        "Memoar cannot start: {}",
                                        ctl.fatal.get().unwrap_or_default()
                                    )
                                })
                            },
                        ))
                        .child(when(
                            move || screen.get() == Screen::Loading,
                            || style::note(|| "Reading this machine's configuration.".to_owned()),
                        ))
                        .child(when(
                            move || screen.get() == Screen::SignIn,
                            move || sign_in::screen(ctl),
                        ))
                        .child(when(
                            move || screen.get() == Screen::Status,
                            move || status::screen(ctl),
                        )),
                ),
            ),
        )
}
