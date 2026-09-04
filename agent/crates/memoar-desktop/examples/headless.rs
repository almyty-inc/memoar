//! Drives the desktop app's capture without opening a window, so the code the
//! window calls can be exercised against a real archive.
use std::path::PathBuf;

#[path = "../src/capture.rs"]
#[allow(dead_code, reason = "the window uses the rest of this module")]
mod capture;

fn main() {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().expect("scratch root"));
    let endpoint = args.next().expect("endpoint");
    let email = args.next().expect("email");
    let password = args.next().expect("password");

    let paths = capture::Paths {
        config_dir: root.join("config"),
        data_dir: root.join("data"),
        home: root.join("home"),
    };
    let state = capture::State::default();

    println!(
        "before: {}",
        serde_json::to_string(&capture::status(&paths, &state)).unwrap()
    );
    let signed = capture::sign_in(&paths, &endpoint, &email, &password).expect("sign in");
    println!("signed in: {}", serde_json::to_string(&signed).unwrap());
    let synced = capture::sync_now(&paths, &state, "2026-09-04T10:00:00Z").expect("sync");
    println!("after capture: {}", serde_json::to_string(&synced).unwrap());
}
