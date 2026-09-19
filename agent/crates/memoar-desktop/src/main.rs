// No console window on Windows for a graphical application.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Memoar desktop application.
//!
//! What it is for: capturing this machine's coding sessions without anyone
//! having to install a command-line tool first. Until now the only way to
//! archive anything was to build the Rust CLI from source, which is not
//! something to ask of somebody who wants their sessions kept.
//!
//! It signs in, registers the machine, captures on a timer, and shows what it
//! has done. Reading the archive stays in the web application, which this can
//! open; duplicating it here would be two archives to keep true.

mod capture;

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use capture::{Paths, State, Status};
use tauri::{Manager, State as TauriState};

/// How often the app captures on its own.
///
/// Two minutes: often enough that an ongoing session is archived while it is
/// still going, rare enough that a laptop is not scanning constantly.
const SYNC_INTERVAL: Duration = Duration::from_secs(120);

struct App {
    paths: Paths,
    state: Arc<State>,
}

#[tauri::command]
fn status(app: TauriState<'_, App>) -> Status {
    capture::status(&app.paths, &app.state)
}

#[tauri::command]
fn sign_in(
    app: TauriState<'_, App>,
    endpoint: String,
    email: String,
    password: String,
) -> Result<Status, String> {
    capture::sign_in(&app.paths, &endpoint, &email, &password)
}

/// What is masked before upload, changed from the window.
///
/// Until now this was settable only by the flags `login` was given, which the
/// window never offered — so the graphical path, the one somebody who does not
/// use a terminal takes, uploaded everything unmasked with no way to change it
/// short of hand-editing `config.json`.
#[tauri::command]
fn set_redaction(
    app: TauriState<'_, App>,
    secrets: bool,
    email_addresses: bool,
    home_paths: bool,
) -> Result<Status, String> {
    capture::set_redaction(&app.paths, &app.state, secrets, email_addresses, home_paths)
}

#[tauri::command]
fn sync_now(app: TauriState<'_, App>) -> Result<Status, String> {
    capture::sync_now(&app.paths, &app.state, &now())
}

/// The archive's web address, derived from the API endpoint this machine uses.
#[tauri::command]
fn archive_url(app: TauriState<'_, App>) -> Option<String> {
    capture::status(&app.paths, &app.state)
        .endpoint
        .map(|endpoint| {
            endpoint
                .trim_end_matches("/v1")
                .trim_end_matches('/')
                .to_owned()
        })
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Captures in the background so the window is not the thing keeping it going.
fn spawn_capture_loop(paths: Paths, state: Arc<State>) {
    thread::spawn(move || {
        loop {
            thread::sleep(SYNC_INTERVAL);
            // A machine that has not signed in has nothing to send, and a
            // failure is recorded for the window rather than retried harder.
            if capture::status(&paths, &state).signed_in {
                let _ = capture::sync_now(&paths, &state, &now());
            }
        }
    });
}

fn main() {
    let paths = match Paths::resolve() {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("memoar: {error}");
            std::process::exit(1);
        }
    };
    let state = Arc::new(State::default());
    spawn_capture_loop(paths.clone(), Arc::clone(&state));

    tauri::Builder::default()
        .setup(move |app| {
            app.manage(App {
                paths: paths.clone(),
                state: Arc::clone(&state),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
            sign_in,
            sync_now,
            set_redaction,
            archive_url
        ])
        .run(tauri::generate_context!())
        .expect("the desktop application failed to start");
}
