//! The Memoar desktop application.
//!
//! What it is for: capturing this machine's coding sessions without anyone
//! having to use a command-line tool. It signs in, registers the machine,
//! captures on a timer, and shows what it has done. Reading the archive stays
//! in the web application, which this can open. Duplicating it here would be
//! two archives to keep true.
//!
//! The window is native on every desktop, drawn by NSH: AppKit on macOS, GTK 4
//! on Linux and Win32 on Windows. `nsh.json` names [`App`] as the root, which
//! `nsh test`, `nsh run` and `nsh package` mount, and `src/main.rs` mounts it
//! for `cargo run`.

pub mod account;
pub mod browser;
pub mod capture;
mod controller;
pub mod failure;
mod fields;
pub mod paths;
pub mod schedule;
mod ui;
pub mod words;

use nsh_core::ui::prelude::*;

pub use account::Credentials;
pub use capture::{LastRun, Redaction, State, Status};
pub use failure::{Failure, FailureKind};
pub use paths::Paths;

/// The app's UI set (`nsh.json` `"rust"`).
#[native_module("memoar-desktop/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>();
}

/// The application's root component.
#[component]
pub fn App() -> impl IntoElement {
    let ctl = controller::Controller::new();
    ctl.start();
    ui::root(ctl)
}
