//! Drives the desktop app's sign-in and capture without opening a window, so
//! the code the window calls can be exercised against a real archive.
//!
//! cargo run --example headless -- <scratch-root> <endpoint> <email> <password>
use std::path::PathBuf;

use memoar_desktop::{Credentials, Paths, State, account, capture};

fn main() {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().expect("scratch root"));
    let endpoint = args.next().expect("endpoint");
    let email = args.next().expect("email");
    let password = args.next().expect("password");

    let paths = Paths {
        config_dir: root.join("config"),
        data_dir: root.join("data"),
        home: root.join("home"),
    };
    let state = State::default();
    let credentials = Credentials::Password { email, password };

    println!(
        "before: {}",
        serde_json::to_string(&capture::status(&paths, &state)).unwrap()
    );
    match account::sign_in(&paths, &state, &endpoint, &credentials) {
        Ok(signed) => println!("signed in: {}", serde_json::to_string(&signed).unwrap()),
        Err(failure) => {
            println!(
                "sign-in failed: {}",
                serde_json::to_string(&failure).unwrap()
            );
            return;
        }
    }
    let synced = capture::sync_now(&paths, &state, &chrono::Utc::now().to_rfc3339());
    match synced {
        Ok(status) => println!("after capture: {}", serde_json::to_string(&status).unwrap()),
        Err(failure) => println!(
            "capture failed: {}",
            serde_json::to_string(&failure).unwrap()
        ),
    }
}
