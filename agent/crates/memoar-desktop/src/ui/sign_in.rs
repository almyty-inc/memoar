//! The sign-in screen: one small form with the same two ways in as
//! `memoar login`.

use nsh_core::ui::prelude::*;

use super::controls::{button, field, segment};
use super::look::look;
use super::style::{below, failure_text, maybe, note, title};
use crate::account::Credentials;
use crate::controller::Controller;

/// The form's width, centred in the window.
const WIDTH: f32 = 320.0;

pub(crate) fn screen(ctl: Controller) -> impl IntoElement {
    // Starts from the address this machine used last, if it has one.
    let known = untracked(|| ctl.status.get().and_then(|status| status.endpoint));
    let endpoint = signal(known.unwrap_or_default());
    let email = signal(String::new());
    let password = signal(String::new());
    let api_key = signal(String::new());
    let with_key = signal(false);
    let web_url = signal(untracked(|| ctl.web_url.get()));

    let submit = move || {
        let credentials = if with_key.get() {
            Credentials::ApiKey(api_key.get())
        } else {
            Credentials::Password {
                email: email.get(),
                password: password.get(),
            }
        };
        ctl.sign_in(endpoint.get(), credentials, web_url.get());
    };
    let idle = move || !ctl.signing_in.get();
    let l = look();

    let form = view()
        .w(px(WIDTH))
        .child(title("Sign in to your archive"))
        .child(below(
            4.0,
            note(|| "The command-line tool here uses the same sign-in.".to_owned()),
        ))
        .child(below(
            20.0,
            field(
                "Archive address",
                "endpoint",
                endpoint,
                false,
                "https://memoar.example.com/v1",
                submit,
            ),
        ))
        .child(below(
            12.0,
            field(
                "Web app address, optional",
                "web-url",
                web_url,
                false,
                "The archive's address without /v1",
                submit,
            ),
        ))
        .child(
            view()
                .mt(px(20.0))
                .flex_row()
                .p(px(2.0))
                .gap(px(2.0))
                .rounded(px(l.radius))
                .bg(l.hover)
                .child(segment(
                    "Email and password",
                    "use-password",
                    move || !with_key.get(),
                    idle,
                    move || with_key.set(false),
                ))
                .child(segment(
                    "API key",
                    "use-api-key",
                    move || with_key.get(),
                    idle,
                    move || with_key.set(true),
                )),
        )
        .child(when(
            move || !with_key.get(),
            move || {
                view()
                    .child(below(
                        12.0,
                        field("Email", "email", email, false, "you@example.com", submit),
                    ))
                    .child(below(
                        12.0,
                        field("Password", "password", password, true, "", submit),
                    ))
            },
        ))
        .child(when(
            move || with_key.get(),
            move || {
                below(
                    12.0,
                    field("API key", "api-key", api_key, true, "memoar_...", submit),
                )
            },
        ))
        .child(maybe(12.0, move || {
            ctl.sign_in_error
                .get()
                .map(|failure| failure_text("sign-in-error", failure))
        }))
        .child(view().mt(px(20.0)).child(button(
            move || {
                if ctl.signing_in.get() {
                    "Signing in".to_owned()
                } else {
                    "Sign in".to_owned()
                }
            },
            "sign-in",
            || true,
            idle,
            None,
            submit,
        )));

    view().items_center().pt(px(36.0)).child(form)
}
