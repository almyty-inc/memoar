//! Opening the web application in the person's browser.
//!
//! NSH 0.2.0 offers no call that opens a URL on the desktops, so this hands it
//! to the program each desktop provides for that: `open` on macOS, the URL
//! handler of `url.dll` on Windows and `xdg-open` elsewhere. No shell is
//! involved, so a URL with `&` in it reaches the browser as written.

use std::process::Command;

/// Whether `url` is one this app will hand to the system at all.
///
/// Only web addresses: the endpoint comes from `config.json`, and a value like
/// `file:///` or a bare path would make the system launcher open something
/// that is not a browser.
#[must_use]
pub fn is_web_address(url: &str) -> bool {
    let url = url.trim();
    (url.starts_with("http://") || url.starts_with("https://"))
        && !url.contains(char::is_whitespace)
}

#[cfg(target_os = "macos")]
fn launcher(url: &str) -> Command {
    let mut command = Command::new("open");
    command.arg(url);
    command
}

#[cfg(target_os = "windows")]
fn launcher(url: &str) -> Command {
    let mut command = Command::new("rundll32");
    command.args(["url.dll,FileProtocolHandler", url]);
    command
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn launcher(url: &str) -> Command {
    let mut command = Command::new("xdg-open");
    command.arg(url);
    command
}

/// Opens `url`, waiting for the launcher (not the browser) to finish.
///
/// # Errors
/// When the URL is not a web address or the launcher cannot be started.
pub fn open(url: &str) -> Result<(), String> {
    let url = url.trim();
    if !is_web_address(url) {
        return Err(format!("{url} is not a web address"));
    }
    launcher(url)
        .status()
        .map_err(|error| format!("could not open the browser: {error}"))
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err(format!("the browser launcher exited with {status}"))
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_addresses_are_opened() {
        assert!(is_web_address("https://archive.example"));
        assert!(is_web_address(" http://127.0.0.1:4000 "));
        assert!(!is_web_address("file:///etc/passwd"));
        assert!(!is_web_address("/Applications/Calculator.app"));
        assert!(!is_web_address("https://a.example/ --flag"));
        assert!(open("file:///etc/passwd").is_err());
    }
}
