//! Runs the application directly on this machine's native backend, for
//! `cargo run`. `nsh run` and `nsh package` build their own runner around the
//! same root component.
//!
//! The window follows the system's light or dark appearance.
//! `MEMOAR_APPEARANCE=light` or `dark` fixes one instead, which is how the
//! screenshots in CI show both on one machine. `MEMOAR_DESKTOP_STATE_DIR`
//! moves what the window keeps between runs (the last capture, pause, the web
//! app's address) out of the system's data directory, for a run that must not
//! share it with the installed app.

// No console window on Windows for a graphical application.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
use nsh_platform_linux as platform;
#[cfg(target_os = "macos")]
use nsh_platform_macos as platform;
#[cfg(target_os = "windows")]
use nsh_platform_windows as platform;

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn appearance() -> platform::Appearance {
    match std::env::var("MEMOAR_APPEARANCE").as_deref() {
        Ok("light") => platform::Appearance::Light,
        Ok("dark") => platform::Appearance::Dark,
        _ => platform::Appearance::System,
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn main() -> impl std::process::Termination {
    env_logger::init();
    let root = memoar_desktop::fonts()
        .into_iter()
        .fold(platform::Root::of::<memoar_desktop::App>(), |root, font| {
            root.font(font)
        });
    platform::run_app(
        platform::AppSource::Rust(root),
        platform::AppOptions {
            title: "memoar".to_owned(),
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            app_id: "dev.memoar.desktop".to_owned(),
            size: (560, 680),
            appearance: appearance(),
            data_dir: std::env::var_os("MEMOAR_DESKTOP_STATE_DIR").map(Into::into),
            ..Default::default()
        },
    )
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
compile_error!("The Memoar desktop application runs on macOS, Windows and Linux.");
