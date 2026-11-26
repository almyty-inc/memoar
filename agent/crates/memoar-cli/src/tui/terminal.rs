//! Taking the terminal over and giving it back.
//!
//! Raw mode, the alternate screen and mouse reporting are undone on every
//! way out: a normal return, an error, and a panic. A panic hook restores the
//! terminal before the message prints, so the message is readable and the
//! shell is usable afterwards.

use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use std::io::{self, Stdout};
use std::sync::Once;

pub(crate) type Backend = CrosstermBackend<Stdout>;

/// Owns the terminal while the TUI runs. Dropping it restores the terminal.
pub(crate) struct Guard {
    pub(crate) terminal: Terminal<Backend>,
}

impl Guard {
    pub(crate) fn enter() -> io::Result<Self> {
        install_panic_hook();
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        if let Err(error) = execute!(stdout, EnterAlternateScreen, EnableMouseCapture) {
            restore();
            return Err(error);
        }
        match Terminal::new(CrosstermBackend::new(stdout)) {
            Ok(mut terminal) => {
                let _ = terminal.hide_cursor();
                let _ = terminal.clear();
                Ok(Self { terminal })
            }
            Err(error) => {
                restore();
                Err(error)
            }
        }
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.terminal.show_cursor();
        restore();
    }
}

/// Undoes everything `enter` did. Safe to call more than once.
pub(crate) fn restore() {
    let _ = disable_raw_mode();
    let _ = execute!(
        io::stdout(),
        DisableMouseCapture,
        LeaveAlternateScreen,
        ratatui::crossterm::cursor::Show
    );
}

fn install_panic_hook() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            // A request thread that panics is caught and reported on screen
            // as a failed request. Only the drawing thread gives the terminal
            // back, as only its panic ends the TUI.
            if std::thread::current().name() == Some("main") {
                restore();
            }
            previous(info);
        }));
    });
}
