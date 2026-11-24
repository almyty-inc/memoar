//! Runs the application directly on this machine's native backend, for
//! `cargo run`. `nsh run` and `nsh package` build their own runner around the
//! same root component.

// No console window on Windows for a graphical application.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
use nsh_platform_linux as platform;
#[cfg(target_os = "macos")]
use nsh_platform_macos as platform;
#[cfg(target_os = "windows")]
use nsh_platform_windows as platform;

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn main() -> impl std::process::Termination {
    env_logger::init();
    platform::run_app(
        platform::AppSource::Rust(platform::Root::of::<memoar_desktop::App>()),
        platform::AppOptions {
            title: "Memoar".to_owned(),
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            app_id: "dev.memoar.desktop".to_owned(),
            size: (560, 720),
            ..Default::default()
        },
    )
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
compile_error!("The Memoar desktop application runs on macOS, Windows and Linux.");
