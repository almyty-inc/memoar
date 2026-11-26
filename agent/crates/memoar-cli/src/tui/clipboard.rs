//! `y`: a session id onto the clipboard.
//!
//! Locally through the platform's own tool. Over SSH that tool would fill the
//! remote machine's clipboard, so there the id goes to the terminal as an
//! OSC 52 sequence, which most terminals put on the clipboard of the machine
//! the person is sitting at. The sequence is sent locally too, for a terminal
//! that has no platform tool to ask.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use std::io::Write;
use std::process::{Command, Stdio};

/// Returns how the text was copied, or why it could not be.
pub(crate) fn copy(text: &str) -> Result<String, String> {
    let remote = std::env::var_os("SSH_CONNECTION").is_some();
    let native = if remote { None } else { native(text) };
    let sequence = osc52(text);
    let mut stdout = std::io::stdout();
    let terminal = stdout
        .write_all(sequence.as_bytes())
        .and_then(|()| stdout.flush());
    match (native, terminal) {
        (Some(tool), _) => Ok(format!("with {tool}")),
        // Nothing reports whether the terminal took it. One without OSC 52
        // ignores it, and the text is in the notice to select by hand.
        (None, Ok(())) => Ok("through the terminal, if it supports OSC 52".to_owned()),
        (None, Err(error)) => Err(error.to_string()),
    }
}

/// The OSC 52 sequence that sets the clipboard to `text`.
pub(crate) fn osc52(text: &str) -> String {
    format!("\x1b]52;c;{}\x07", BASE64.encode(text.as_bytes()))
}

/// The first platform tool that takes the text.
fn native(text: &str) -> Option<&'static str> {
    let tools: &[(&str, &[&str])] = if cfg!(target_os = "macos") {
        &[("pbcopy", &[])]
    } else if cfg!(windows) {
        &[("clip", &[])]
    } else {
        &[
            ("wl-copy", &[]),
            ("xclip", &["-selection", "clipboard"]),
            ("xsel", &["--clipboard", "--input"]),
        ]
    };
    tools
        .iter()
        .find(|(program, arguments)| run(program, arguments, text))
        .map(|(program, _)| *program)
}

fn run(program: &str, arguments: &[&str], text: &str) -> bool {
    let Ok(mut child) = Command::new(program)
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let written = child
        .stdin
        .take()
        .is_some_and(|mut stdin| stdin.write_all(text.as_bytes()).is_ok());
    child.wait().is_ok_and(|status| status.success()) && written
}
