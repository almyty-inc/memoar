//! The window: one screen for signing in, one for everything after.

mod chrome;
mod controls;
mod look;
mod sign_in;
mod status;
mod style;

use nsh_core::ui::prelude::*;

use crate::controller::Controller;
use look::look;

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
    let l = look();
    let screen = computed(move || screen_of(ctl));
    let root = view().flex_1().bg(l.page).text_color(l.text);
    let root = match l.font {
        Some(family) => root.font_family(family),
        None => root,
    };
    root.child(chrome::bar()).child(
        scroll().flex_1().child(
            view()
                .px(px(24.0))
                .pt(px(20.0))
                .pb(px(24.0))
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
    )
}
