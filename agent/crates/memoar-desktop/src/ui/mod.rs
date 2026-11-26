//! The window: almyty's product field, the memoar title bar, and one card
//! floating on the field that holds the screen: sign-in, or everything after.

mod agents;
pub(crate) mod brand;
mod chrome;
mod controls;
mod look;
mod sign_in;
mod status;
mod style;

use nsh_core::ui::desktop::title_bar;
use nsh_core::ui::prelude::*;
use nsh_core::{BoxShadow, Color};

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

/// The card's float: almyty's 0 20px 50px of deep blue at 12%.
fn float() -> [BoxShadow; 1] {
    [BoxShadow {
        offset_x: px(0.0),
        offset_y: px(20.0),
        blur: px(50.0),
        spread: px(0.0),
        color: Color::rgba(20, 50, 110, 31),
        inset: false,
    }]
}

fn content(ctl: Controller) -> impl IntoElement {
    let screen = computed(move || screen_of(ctl));
    view()
        .flex_1()
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
        ))
}

pub(crate) fn root(ctl: Controller) -> impl IntoElement {
    let l = look();
    let [from, via, to] = l.field;
    let card = view()
        .flex_1()
        .bg(l.canvas)
        .rounded(px(18.0))
        .border(px(1.0))
        .border_color(l.rule)
        .shadow(float())
        .overflow_hidden()
        .child(
            scroll().flex_1().child(
                view()
                    .px(px(32.0))
                    .pt(px(26.0))
                    .pb(px(16.0))
                    .child(content(ctl)),
            ),
        )
        // The endorsement stays at the foot of the card while the screen
        // above it scrolls.
        .child(
            view()
                .py(px(10.0))
                .border_t(px(look::hair()))
                .border_color(l.rule)
                .child(brand::endorsement()),
        );
    view()
        .flex_1()
        .bg_linear_to_br()
        .gradient_from(from)
        .gradient_via(via)
        .gradient_via_position(percentage(0.45))
        .gradient_to(to)
        .text_color(l.text)
        .font_family(brand::SANS)
        .child(chrome::bar())
        .child(
            view()
                .flex_1()
                .px(px(14.0))
                .pb(px(14.0))
                .pt(move || px(if title_bar().top.0 > 0.0 { 0.0 } else { 14.0 }))
                .child(card),
        )
}
