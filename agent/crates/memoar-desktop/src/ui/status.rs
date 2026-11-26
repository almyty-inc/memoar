//! The status screen: what this machine captured, what failed, and the
//! controls that change it, as grouped lists of facts.

use nsh_core::ui::prelude::*;

use super::controls::{button, switch};
use super::look::{look, motion};
use super::style::{
    BASE, SMALL, below, fact, fact_id, failure_text, group, maybe, note, row, section, title,
};
use crate::capture::{Redaction, Status};
use crate::controller::Controller;
use crate::schedule::{Mode, caption};
use crate::words;

const CAPTURE_KEYS: &str = "mod+r";
const WEB_APP_KEYS: &str = "mod+o";

pub(crate) fn screen(ctl: Controller) -> impl IntoElement {
    let status = move || ctl.status.get().unwrap_or_default();
    on_key(CAPTURE_KEYS, move |_| ctl.capture());
    on_key(WEB_APP_KEYS, move |_| ctl.open_web_app());
    view()
        .child(header(ctl, status))
        .child(maybe(16.0, move || {
            ctl.last_error()
                .map(|failure| failure_text("capture-error", failure))
        }))
        .child(when(
            move || ctl.mode() == Mode::Stopped,
            move || {
                view().mt(px(12.0)).flex_row().child(button(
                    || "Sign in again".to_owned(),
                    "sign-in-again",
                    || true,
                    || true,
                    None,
                    move || ctl.sign_out(),
                ))
            },
        ))
        .child(below(20.0, facts(ctl, status)))
        .child(below(24.0, masks(ctl)))
        .child(below(24.0, footer(ctl)))
        .child(maybe(12.0, move || {
            ctl.notice.get().map(|notice| note(move || notice.clone()))
        }))
}

/// The title and what capture is doing, with the two capture controls.
fn header(ctl: Controller, status: impl Fn() -> Status + Copy + 'static) -> impl IntoElement {
    let l = look();
    let tone = move || match ctl.mode() {
        Mode::Stopped => l.danger,
        Mode::Paused | Mode::SignedOut => l.warning,
        Mode::Capturing | Mode::Busy => l.ok,
    };
    let state = view()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .child(
            view()
                .w(px(7.0))
                .h(px(7.0))
                .rounded(px(3.5))
                .bg(tone)
                .transition_colors()
                .duration(motion()),
        )
        .child(
            text(move || caption(ctl.mode()).to_owned())
                .test_id("mode")
                .text_size(px(BASE))
                .text_color(l.text_2),
        );
    let about = view()
        .flex_1()
        .child(title("This machine"))
        .child(below(4.0, state))
        .child(maybe(4.0, move || {
            status().disk_low.map(|detail| {
                text(words::disk(Some(&detail)))
                    .text_size(px(SMALL))
                    .text_color(l.warning)
            })
        }));
    view()
        .flex_row()
        .items_start()
        .gap(px(12.0))
        .child(about)
        .child(
            view()
                .flex_row()
                .gap(px(8.0))
                .child(button(
                    move || {
                        if ctl.paused.get() {
                            "Resume".to_owned()
                        } else {
                            "Pause".to_owned()
                        }
                    },
                    "pause",
                    || false,
                    move || ctl.mode() != Mode::Stopped,
                    None,
                    move || ctl.toggle_pause(),
                ))
                .child(button(
                    move || {
                        if ctl.busy.get() {
                            "Capturing".to_owned()
                        } else {
                            "Capture now".to_owned()
                        }
                    },
                    "capture-now",
                    || true,
                    move || ctl.can_capture(),
                    Some(key_label(CAPTURE_KEYS)),
                    move || ctl.capture(),
                )),
        )
}

fn facts(ctl: Controller, status: impl Fn() -> Status + Copy + 'static) -> impl IntoElement {
    let held = move || status().held.is_some_and(|held| held > 0);
    group()
        .child(fact(true, "Archive", move || {
            status().endpoint.unwrap_or_default()
        }))
        .child(fact(false, "Web app", move || {
            ctl.web_app().unwrap_or_default()
        }))
        .child(fact_id("Machine", move || {
            status().machine_id.unwrap_or_default()
        }))
        .child(fact(false, "Last capture", move || {
            words::last_capture(status().last_sync_at.as_deref(), ctl.now.get())
        }))
        .child(fact(false, "Last upload", move || {
            words::count(status().last_uploaded, "session")
        }))
        .child(fact(false, "Uploaded in all", move || {
            words::count(status().uploaded_total, "artifact")
        }))
        .child(fact(false, "Waiting", move || {
            let status = status();
            words::waiting(status.queued, status.retrying)
        }))
        .child(fact(false, "Sources", move || {
            words::sources(&status().sources)
        }))
        .child(when(held, move || {
            fact(false, "Held back", move || {
                words::count(status().held, "artifact")
            })
        }))
}

/// What is masked before upload. The window has to show it and let it be
/// changed: a first sign-in masks secrets only, and nobody should have to edit
/// `config.json` to choose otherwise.
fn masks(ctl: Controller) -> impl IntoElement {
    let current = move || {
        ctl.status
            .get()
            .and_then(|status| status.redaction)
            .unwrap_or_default()
    };
    let toggle = move |change: fn(&mut Redaction)| {
        let mut next = current();
        change(&mut next);
        ctl.set_redaction(next);
    };
    view().child(section("Masked before upload")).child(
        group()
            .child(mask(
                true,
                "Secrets such as keys and tokens",
                "mask-secrets",
                move || current().secrets,
                move || toggle(|next| next.secrets = !next.secrets),
            ))
            .child(mask(
                false,
                "Email addresses",
                "mask-email",
                move || current().email_addresses,
                move || toggle(|next| next.email_addresses = !next.email_addresses),
            ))
            .child(mask(
                false,
                "Home directory paths",
                "mask-home",
                move || current().home_paths,
                move || toggle(|next| next.home_paths = !next.home_paths),
            )),
    )
}

fn mask(
    first: bool,
    label: &'static str,
    id: &'static str,
    on: impl Fn() -> bool + Copy + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    row(first)
        .child(text(label).text_size(px(BASE)).flex_1())
        .child(switch(label, id, on, press))
}

/// Leaving the window: the web app, or this machine's sign-in.
fn footer(ctl: Controller) -> impl IntoElement {
    view()
        .flex_row()
        .justify_end()
        .gap(px(8.0))
        .child(button(
            || "Open web app".to_owned(),
            "open-web-app",
            || false,
            || true,
            Some(key_label(WEB_APP_KEYS)),
            move || ctl.open_web_app(),
        ))
        .child(button(
            || "Sign out".to_owned(),
            "sign-out",
            || false,
            move || !ctl.busy.get(),
            None,
            move || ctl.sign_out(),
        ))
}
