//! The status screen: what this machine captured, what failed, and the
//! controls that change it.

use nsh_base::theme;
use nsh_core::ui::prelude::*;

use super::style::{button, failure_box, heading, note, row};
use crate::capture::{Redaction, Status};
use crate::controller::Controller;
use crate::schedule::{Mode, caption};
use crate::words;

pub(crate) fn screen(ctl: Controller) -> impl IntoElement {
    let status = move || ctl.status.get().unwrap_or_default();
    view()
        .gap_4()
        .child(
            view()
                .gap_1()
                .child(heading("This machine"))
                .child(text(move || caption(ctl.mode()).to_owned()).test_id("mode")),
        )
        .child(dynamic(move || match ctl.last_error() {
            Some(failure) => failure_box("capture-error", failure).into_element(),
            None => view().into_element(),
        }))
        .child(when(
            move || ctl.mode() == Mode::Stopped,
            move || {
                view().flex_row().child(button(
                    || "Sign in again".to_owned(),
                    "sign-in-again",
                    || true,
                    || true,
                    move || ctl.sign_out(),
                ))
            },
        ))
        .child(details(ctl, status))
        .child(actions(ctl))
        .child(masks(ctl))
        .child(dynamic(move || match ctl.notice.get() {
            Some(notice) => note(move || notice.clone()).into_element(),
            None => view().into_element(),
        }))
}

fn details(ctl: Controller, status: impl Fn() -> Status + Copy + 'static) -> impl IntoElement {
    view()
        .p_3()
        .rounded(px(6.0))
        .border_1()
        .border_color(move || theme().border)
        .child(row("Archive", move || {
            status().endpoint.unwrap_or_default()
        }))
        .child(row("Web app", move || ctl.web_app().unwrap_or_default()))
        .child(row("Machine", move || {
            status().machine_id.unwrap_or_default()
        }))
        .child(row("Last capture", move || {
            words::last_capture(status().last_sync_at.as_deref(), ctl.now.get())
        }))
        .child(row("Uploaded by the last capture", move || {
            words::count(status().last_uploaded, "session")
        }))
        .child(row("Uploaded from this machine", move || {
            words::count(status().uploaded_total, "artifact")
        }))
        .child(row("Waiting to upload", move || {
            let status = status();
            words::waiting(status.queued, status.retrying)
        }))
        .child(row("Sources found", move || {
            words::sources(&status().sources)
        }))
        .child(row("Disk space", move || {
            words::disk(status().disk_low.as_deref())
        }))
        .child(row("Held back by the capture policy", move || {
            words::count(status().held, "artifact")
        }))
}

fn actions(ctl: Controller) -> impl IntoElement {
    view()
        .flex_row()
        .flex_wrap()
        .gap_2()
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
            move || ctl.capture(),
        ))
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
            move || ctl.toggle_pause(),
        ))
        .child(button(
            || "Open web app".to_owned(),
            "open-web-app",
            || false,
            || true,
            move || ctl.open_web_app(),
        ))
        .child(button(
            || "Sign out".to_owned(),
            "sign-out",
            || false,
            move || !ctl.busy.get(),
            move || ctl.sign_out(),
        ))
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
    view()
        .gap_1()
        .child(note(|| "Masked before upload".to_owned()))
        .child(mask(
            "Secrets such as keys and tokens",
            "mask-secrets",
            move || current().secrets,
            move || {
                let mut next: Redaction = current();
                next.secrets = !next.secrets;
                ctl.set_redaction(next);
            },
        ))
        .child(mask(
            "Email addresses",
            "mask-email",
            move || current().email_addresses,
            move || {
                let mut next = current();
                next.email_addresses = !next.email_addresses;
                ctl.set_redaction(next);
            },
        ))
        .child(mask(
            "Home directory paths",
            "mask-home",
            move || current().home_paths,
            move || {
                let mut next = current();
                next.home_paths = !next.home_paths;
                ctl.set_redaction(next);
            },
        ))
}

fn mask(
    label: &'static str,
    id: &'static str,
    on: impl Fn() -> bool + Copy + 'static,
    press: impl Fn() + 'static,
) -> impl IntoElement {
    view()
        .flex_row()
        .items_center()
        .justify_between()
        .child(text(label).text_size(px(13.0)))
        .child(button(
            move || {
                if on() {
                    "On".to_owned()
                } else {
                    "Off".to_owned()
                }
            },
            id,
            on,
            || true,
            press,
        ))
}
