//! The sign-in screen: the same two ways in as `memoar login`.

use nsh_core::ui::prelude::*;

use super::style::{button, failure_box, field, heading, note};
use crate::account::Credentials;
use crate::controller::Controller;

pub(crate) fn screen(ctl: Controller) -> impl IntoElement {
    // Starts from the address this machine used last, if it has one.
    let known = untracked(|| ctl.status.get().and_then(|status| status.endpoint));
    let endpoint = signal(known.unwrap_or_default());
    let email = signal(String::new());
    let password = signal(String::new());
    let api_key = signal(String::new());
    let with_key = signal(false);

    let submit = move || {
        let credentials = if with_key.get() {
            Credentials::ApiKey(api_key.get())
        } else {
            Credentials::Password {
                email: email.get(),
                password: password.get(),
            }
        };
        ctl.sign_in(endpoint.get(), credentials);
    };
    let idle = move || !ctl.signing_in.get();

    view()
        .gap_4()
        .child(heading("Sign in to your archive"))
        .child(note(|| {
            "Memoar captures the coding sessions on this machine and uploads them to your archive. \
             The command-line tool on this machine uses the same sign-in."
                .to_owned()
        }))
        .child(field(
            "Archive address",
            "endpoint",
            endpoint,
            false,
            "https://memoar.example.com/v1",
            submit,
        ))
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(button(
                    || "Email and password".to_owned(),
                    "use-password",
                    move || !with_key.get(),
                    idle,
                    move || with_key.set(false),
                ))
                .child(button(
                    || "API key".to_owned(),
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
                    .gap_4()
                    .child(field(
                        "Email",
                        "email",
                        email,
                        false,
                        "you@example.com",
                        submit,
                    ))
                    .child(field("Password", "password", password, true, "", submit))
            },
        ))
        .child(when(
            move || with_key.get(),
            move || field("API key", "api-key", api_key, true, "memoar_...", submit),
        ))
        .child(dynamic(move || match ctl.sign_in_error.get() {
            Some(failure) => failure_box("sign-in-error", failure).into_element(),
            None => view().into_element(),
        }))
        .child(view().flex_row().child(button(
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
            submit,
        )))
}
